import spine from '../libs/spine-webgl.js';
import webgl = spine.webgl;
import outlineFragmentShader from '../shaders/OutlineFragment.glsl';
import outlineVertexShader from '../shaders/OutlineVertex.glsl';
import { CharacterModel } from './types.js';

const MOVING_SPEED = 40; // pixels per second, before displayScale

const GRAVITY = 1000; // pixels per second squared
const DRAG = 0.98; // velocity kept per 1/60s; air resistance
const MAX_VELOCITY = 1000; // maximum velocity in pixels per second
const MIN_VELOCITY = 5; // threshold for stopping
const BOUNCE_DAMPING = 0.7; // energy loss on bounce

// Sizes in CSS pixels, before displayScale. Some Special animations reach about 155px
// either side of the model's center, so the canvas is wider than the body it holds.
// Screen edges collide with the body: the empty sides of the canvas may hang off-screen.
const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 170;
const BODY_WIDTH = 150;
const MODEL_SCALE = 0.3 * 0.75;
// Supersampling beyond 2x costs fill rate without a visible gain at this size
const MAX_PIXEL_RATIO = 2;
const ANIMATION_MIX_SECONDS = 0.3;

const DRAG_SLOP = 6; // pixels a pointer may travel and still count as a click or tap
const THROW_SAMPLE_MS = 80;
const LONG_PRESS_MS = 500;
const TOUCH_HIT_RADIUS = 12; // fingers are less precise than a mouse

interface Behavior {
    // Seconds to stay in this animation. Checked at loop boundaries, so it always finishes a loop.
    minSeconds: number;
    maxSeconds: number;
    // Play a single loop, then move on
    once?: boolean;
    // Relative weights of what comes next. Animations a model lacks are skipped.
    next: { [animation: string]: number };
}

const BEHAVIORS: { [animation: string]: Behavior } = {
    Relax: { minSeconds: 2, maxSeconds: 6, next: { Move: 6, Sit: 1.5, Sleep: 0.5, Special: 1, Interact: 0.5, Relax: 1 } },
    Move: { minSeconds: 4, maxSeconds: 12, next: { Relax: 7, Move: 2, Sit: 1 } },
    Sit: { minSeconds: 8, maxSeconds: 20, next: { Relax: 4, Sleep: 1 } },
    Sleep: { minSeconds: 15, maxSeconds: 40, next: { Relax: 1 } },
    Interact: { minSeconds: 0, maxSeconds: 0, once: true, next: { Relax: 1 } },
    Special: { minSeconds: 0, maxSeconds: 0, once: true, next: { Relax: 1 } },
};

interface SpineCharacter {
    skeleton: spine.Skeleton;
    state: spine.AnimationState;
}

interface Action {
    animation: string;
    direction: Direction;
    timestamp: number;
    duration: number;
}

type Direction = "left" | "right";

export class Character {
    private canvas!: HTMLCanvasElement;
    private gl!: WebGLRenderingContext;
    private shader!: webgl.Shader;
    private batcher!: webgl.PolygonBatcher;
    private mvp!: webgl.Matrix4;
    private texture?: webgl.GLTexture;
    public readonly ready: Promise<boolean | null>;
    private skeletonRenderer!: webgl.SkeletonRenderer;
    private lastFrameTime!: number;
    private framebuffer!: WebGLFramebuffer;
    private framebufferTexture!: WebGLTexture;
    private outlineShader!: WebGLProgram;
    private quadBuffer!: WebGLBuffer;

    private isMouseOver: boolean = false;

    // Dragging state
    private isDragging: boolean = false;
    private dragMoved: boolean = false;
    private dragOriginX: number = 0;
    private dragOriginY: number = 0;
    private dragStartRelativeX: number = 0;
    private dragStartRelativeY: number = 0;
    private dragSamples: { x: number; y: number; time: number }[] = [];
    private longPressTimer: number | null = null;
    private longPressFired: boolean = false;

    // Physics state
    private velocity = { x: 0, y: 0 };

    private model: CharacterModel;
    private character!: SpineCharacter;
    private animationNames: string[] = [];

    private currentAction: Action = {
        animation: "Relax",
        direction: "right",
        timestamp: 0,
        duration: 0,
    };

    private position: { x: number; y: number } = {
        x: NaN, // will be set to a random value
        y: 1e9 // will be bounded to the bottom of the window
    };

    private animationFrameId: number | null = null;
    // Only the newest loadCharacterModel call may take effect
    private loadToken: number = 0;
    private listeners = new AbortController();

    private allowInteract: boolean = true;
    private displayScale: number;

    // Supersampling is necessary for high-res display
    private pixelRatio!: number;

    constructor(
        canvasId: string,
        private onContextMenu: (e: MouseEvent | TouchEvent) => void,
        initialCharacter: CharacterModel,
        allowInteract: boolean = true,
        displayScale: number = 1,
    ) {
        this.allowInteract = allowInteract;
        this.displayScale = displayScale;
        this.model = initialCharacter;
        this.mvp = new webgl.Matrix4();
        this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

        // Initialize canvas and WebGL
        this.initializeCanvas(canvasId);
        this.initializeWebGL();
        this.setupEventListeners();

        // Load initial character
        this.loadFromSessionStorage();
        this.ready = this.loadCharacterModel(this.model);
    }

    private initializeCanvas(canvasId: string): void {
        this.canvas = document.createElement('canvas');
        this.canvas.classList.add("arkpets-canvas");
        this.canvas.id = canvasId;
        document.body.appendChild(this.canvas);
        this.canvas.style.pointerEvents = "none";
    }

    private initializeWebGL(): void {
        const gl = this.canvas.getContext("webgl", {
            alpha: true,
            // Ark-Models textures are premultiplied, and so is everything we composite
            premultipliedAlpha: true
        }) as WebGLRenderingContext | null;

        if (!gl) {
            this.canvas.remove();
            throw new Error('WebGL is unavailable.');
        }
        this.gl = gl;

        this.initFramebuffer();

        // Create WebGL objects
        this.shader = webgl.Shader.newTwoColoredTextured(this.gl);
        this.batcher = new webgl.PolygonBatcher(this.gl);
        this.skeletonRenderer = new webgl.SkeletonRenderer(new webgl.ManagedWebGLRenderingContext(this.gl));
        this.skeletonRenderer.premultipliedAlpha = true;
    }

    private setupEventListeners(): void {
        const { signal } = this.listeners;

        // Track mouse position to decide mouse over
        document.addEventListener('mousemove', this.handleMouseMove.bind(this), { signal });
        window.addEventListener('pagehide', this.saveToSessionStorage.bind(this), { signal });

        if (this.allowInteract) {
            // React to click events
            this.canvas.addEventListener('click', this.handleCanvasClick.bind(this), { signal });

            // Context menu
            this.canvas.addEventListener('contextmenu', this.onContextMenu, { signal });

            // Mouse events
            this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this), { signal });
            document.addEventListener('mousemove', this.handleMouseDrag.bind(this), { signal });
            document.addEventListener('mouseup', this.endDrag.bind(this), { signal });

            // The canvas only takes pointer events while hovered, which never happens on touch.
            // So check touches on the document, and ignore the ones that miss the pet.
            document.addEventListener('touchstart', this.handleTouchStart.bind(this), { signal, passive: false, capture: true });
            document.addEventListener('touchmove', this.handleTouchMove.bind(this), { signal, passive: false });
            document.addEventListener('touchend', this.handleTouchEnd.bind(this), { signal });
            document.addEventListener('touchcancel', this.handleTouchEnd.bind(this), { signal });
        }
    }

    private initFramebuffer(): void {
        // Create and bind framebuffer
        this.framebuffer = this.gl.createFramebuffer()!;
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);

        // Create and bind texture
        this.framebufferTexture = this.gl.createTexture()!;
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.framebufferTexture);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.canvas.width, this.canvas.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

        // Attach texture to framebuffer
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.framebufferTexture, 0);

        // Create quad buffer for second pass
        this.quadBuffer = this.gl.createBuffer()!;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quadBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,  // Bottom left
             1, -1,  // Bottom right
            -1,  1,  // Top left
             1,  1   // Top right
        ]), this.gl.STATIC_DRAW);

        // Create and compile outline shader
        const vertexShader = this.gl.createShader(this.gl.VERTEX_SHADER)!;
        this.gl.shaderSource(vertexShader, outlineVertexShader);
        this.gl.compileShader(vertexShader);
        if (!this.gl.getShaderParameter(vertexShader, this.gl.COMPILE_STATUS)) {
            console.error('Vertex shader compilation failed:', this.gl.getShaderInfoLog(vertexShader));
        }

        const fragmentShader = this.gl.createShader(this.gl.FRAGMENT_SHADER)!;
        this.gl.shaderSource(fragmentShader, outlineFragmentShader);
        this.gl.compileShader(fragmentShader);
        if (!this.gl.getShaderParameter(fragmentShader, this.gl.COMPILE_STATUS)) {
            console.error('Fragment shader compilation failed:', this.gl.getShaderInfoLog(fragmentShader));
        }

        this.outlineShader = this.gl.createProgram()!;
        this.gl.attachShader(this.outlineShader, vertexShader);
        this.gl.attachShader(this.outlineShader, fragmentShader);
        this.gl.linkProgram(this.outlineShader);
        if (!this.gl.getProgramParameter(this.outlineShader, this.gl.LINK_STATUS)) {
            console.error('Program linking failed:', this.gl.getProgramInfoLog(this.outlineShader));
        }
    }

    // true = displayed, false = failed, null = superseded by another load or destroy().
    public async loadCharacterModel(model: CharacterModel): Promise<boolean | null> {
        const token = ++this.loadToken;
        const fetchResource = async (path: string) => {
            const encoded = path.split('/').map(encodeURIComponent).join('/');
            const response = await fetch((model.resourcePath ?? '') + encoded);
            if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
            return response;
        };
        let pendingTexture: webgl.GLTexture | undefined;
        try {
            const [binary, atlasText, blob] = await Promise.all([
                fetchResource(model.skeleton).then(r => r.arrayBuffer()),
                fetchResource(model.atlas).then(r => r.text()),
                fetchResource(model.texture).then(r => r.blob()),
            ]);
            if (token !== this.loadToken) return null;
            const image = new Image();
            image.src = URL.createObjectURL(blob);
            try {
                await image.decode();
            } finally {
                URL.revokeObjectURL(image.src);
            }
            if (token !== this.loadToken) return null;

            const texture = pendingTexture = new webgl.GLTexture(this.gl, image);
            const atlas = new spine.TextureAtlas(atlasText, name => {
                if (name !== model.texture.split('/').pop()) throw new Error(`Unexpected atlas page: ${name}`);
                return texture;
            });
            const character = this.loadCharacter(atlas, new Uint8Array(binary), MODEL_SCALE * this.pixelRatio * this.displayScale);
            if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
            this.texture?.dispose();
            this.texture = pendingTexture;
            pendingTexture = undefined;
            this.model = model;
            this.character = character;
            this.currentAction = this.makeAction("Relax", this.currentAction.direction);
            this.lastFrameTime = performance.now() / 1000;
            if (!Number.isFinite(this.position.x)) {
                const { minX, maxX } = this.horizontalBounds();
                this.position.x = minX + Math.random() * (maxX - minX);
            }
            this.render();
            return true;
        } catch (error) {
            if (token !== this.loadToken) return null;
            console.error("Failed to load character:", model.name, error);
            return false;
        } finally {
            pendingTexture?.dispose();
        }
    }

    public fadeOut(): Promise<void> {
        return new Promise((resolve) => {
            let opacity = 1;
            const fadeInterval = setInterval(() => {
                opacity -= 0.1;
                this.canvas.style.opacity = opacity.toString();

                if (opacity <= 0) {
                    clearInterval(fadeInterval);
                    resolve();
                }
            }, 30);
        });
    }

    private sessionKey(): string {
        return 'arkpets-character-' + this.canvas.id;
    }

    private saveToSessionStorage(): void {
        try {
            sessionStorage.setItem(this.sessionKey(), JSON.stringify({ position: this.position }));
        } catch (e) { /* storage may be blocked; losing the position is harmless */ }
    }

    private loadFromSessionStorage(): void {
        try {
            const saved = sessionStorage.getItem(this.sessionKey());
            if (saved) {
                this.position = JSON.parse(saved).position ?? this.position;
            }
        } catch (e) { /* start from the default position */ }
    }

    private horizontalBounds(): { minX: number; maxX: number } {
        const margin = (CANVAS_WIDTH - BODY_WIDTH) / 2 * this.displayScale;
        return {
            minX: -margin,
            maxX: Math.max(-margin, window.innerWidth - this.canvas.offsetWidth + margin),
        };
    }

    private loadCharacter(atlas: spine.TextureAtlas, binary: Uint8Array, scale: number): SpineCharacter {
        const atlasLoader = new spine.AtlasAttachmentLoader(atlas);
        const skeletonBinary = new spine.SkeletonBinary(atlasLoader);

        skeletonBinary.scale = scale;
        const skeletonData = skeletonBinary.readSkeletonData(binary);
        const skeleton = new spine.Skeleton(skeletonData);

        const animationNames = Object.keys(BEHAVIORS).filter(name => skeletonData.findAnimation(name) !== null);

        const animationStateData = new spine.AnimationStateData(skeleton.data);

        // Animation transitions
        animationNames.forEach(fromAnim => {
            animationNames.forEach(toAnim => {
                if (fromAnim !== toAnim) {
                    animationStateData.setMix(fromAnim, toAnim, ANIMATION_MIX_SECONDS);
                }
            });
        });

        const animationState = new spine.AnimationState(animationStateData);

        animationState.setAnimation(0, "Relax", true);
        this.animationNames = animationNames;

        // Listen for animation completion
        const self = this;
        class AnimationStateAdapter extends spine.AnimationStateAdapter {
            complete(entry: spine.TrackEntry): void {
                self.handleLoopComplete();
            }
        }
        animationState.addListener(new AnimationStateAdapter());

        // Set canvas display size
        const cssWidth = Math.round(CANVAS_WIDTH * this.displayScale);
        const cssHeight = Math.round(CANVAS_HEIGHT * this.displayScale);
        this.canvas.style.width = cssWidth + "px";
        this.canvas.style.height = cssHeight + "px";

        // Set canvas internal resolution
        this.canvas.width = Math.round(cssWidth * this.pixelRatio);
        this.canvas.height = Math.round(cssHeight * this.pixelRatio);

        // Update the projection matrix to match the new resolution
        this.mvp.ortho2d(0, 0, this.canvas.width, this.canvas.height);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        // Scale up the skeleton position to match the higher resolution
        skeleton.x = this.canvas.width / 2;
        skeleton.y = 0;

        // Update framebuffer texture size
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.framebufferTexture);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.canvas.width, this.canvas.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);

        return {
            skeleton,
            state: animationState,
        };
    }

    // Mouse position (client, no transform, no supersampling)
    private currentMousePos = { x: 0, y: 0 };

    private handleMouseMove(event: MouseEvent): void {
        this.currentMousePos.x = event.clientX;
        this.currentMousePos.y = event.clientY;
    }

    // Whether the pet has an opaque pixel at this client position, as of the last rendered frame.
    private isOpaqueAt(clientX: number, clientY: number): boolean {
        const rect = this.canvas.getBoundingClientRect();
        const pixelX = (clientX - rect.x) * this.pixelRatio;
        const pixelY = this.canvas.height - (clientY - rect.y) * this.pixelRatio;
        if (pixelX < 0 || pixelX >= this.canvas.width || pixelY < 0 || pixelY >= this.canvas.height) {
            return false;
        }
        const pixel = new Uint8Array(4);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
        this.gl.readPixels(pixelX, pixelY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        return pixel[3] !== 0;
    }

    private render(): void {
        const now = performance.now() / 1000;
        // Limit delta to 0.1s, effectively pausing the animation when the window is in background
        const delta = Math.min(now - this.lastFrameTime, 0.1);
        this.lastFrameTime = now;
        this.currentAction.timestamp += delta;

        const { minX, maxX } = this.horizontalBounds();
        const maxY = window.innerHeight - this.canvas.offsetHeight;

        // Apply physics when not dragging
        if (!this.isDragging) {
            // Apply gravity
            this.velocity.y += GRAVITY * delta;

            // Apply drag
            const drag = Math.pow(DRAG, delta * 60); // the same fall on any refresh rate
            this.velocity.x *= drag;
            this.velocity.y *= drag;
            if (Math.abs(this.velocity.x) < MIN_VELOCITY) {
                this.velocity.x = 0;
            }

            // Clamp velocities
            this.velocity.x = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, this.velocity.x));
            this.velocity.y = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, this.velocity.y));

            // Update position
            this.position.x += this.velocity.x * delta;
            this.position.y += this.velocity.y * delta;

            // Bounce off walls
            if (this.position.x < minX) {
                this.position.x = minX;
                this.velocity.x = -this.velocity.x * BOUNCE_DAMPING;
            } else if (this.position.x > maxX) {
                this.position.x = maxX;
                this.velocity.x = -this.velocity.x * BOUNCE_DAMPING;
            }

            // Bounce off floor/ceiling
            if (this.position.y < 0) {
                this.position.y = 0;
                this.velocity.y = 0;
            } else if (this.position.y > maxY) {
                this.position.y = maxY;
                this.velocity.y = 0;
            }

            // Walk while the "Move" animation plays, but not in mid-air
            if (this.currentAction.animation === "Move" && this.position.y >= maxY) {
                const movement = MOVING_SPEED * this.displayScale * delta;
                if (this.currentAction.direction === "left") {
                    this.position.x -= movement;
                    // Turn around when reaching left edge
                    if (this.position.x <= minX) {
                        this.position.x = minX;
                        this.currentAction.direction = "right";
                    }
                } else {
                    this.position.x += movement;
                    // Turn around when reaching right edge
                    if (this.position.x >= maxX) {
                        this.position.x = maxX;
                        this.currentAction.direction = "left";
                    }
                }
            }
        }

        // Update canvas position to `position`
        this.canvas.style.transform = `translate(${this.position.x}px, ${this.position.y}px)`;

        // 1st pass - render Spine character to framebuffer
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        this.character.skeleton.scaleX = this.currentAction.direction === "left" ? -1 : 1;

        this.character.state.update(delta);
        this.character.state.apply(this.character.skeleton);
        this.character.skeleton.updateWorldTransform();

        this.shader.bind();
        this.shader.setUniformi(webgl.Shader.SAMPLER, 0);
        this.shader.setUniform4x4f(webgl.Shader.MVP_MATRIX, this.mvp.values);

        this.batcher.begin(this.shader);
        this.skeletonRenderer.draw(this.batcher, this.character.skeleton);
        this.batcher.end();

        this.shader.unbind();

        // Read pixels before 2nd pass to determine if mouse is over character
        this.isMouseOver = this.isOpaqueAt(this.currentMousePos.x, this.currentMousePos.y);
        this.canvas.style.pointerEvents = this.allowInteract && this.isMouseOver ? 'auto' : 'none';

        // 2nd pass - copy to screen with outline effect. The framebuffer is already
        // premultiplied, so draw it without blending.
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.disable(this.gl.BLEND);

        this.gl.useProgram(this.outlineShader);

        // Set uniforms
        const uTexture = this.gl.getUniformLocation(this.outlineShader, "u_texture");
        const uOutlineColor = this.gl.getUniformLocation(this.outlineShader, "u_outlineColor");
        const uOutlineWidth = this.gl.getUniformLocation(this.outlineShader, "u_outlineWidth");
        const uTextureSize = this.gl.getUniformLocation(this.outlineShader, "u_textureSize");
        const uAlpha = this.gl.getUniformLocation(this.outlineShader, "u_alpha");

        this.gl.uniform1i(uTexture, 0); // Use texture unit 0 for spine character
        this.gl.uniform4f(uOutlineColor, 1.0, 1.0, 0.0, 1.0); // yellow
        this.gl.uniform1f(uOutlineWidth, this.allowInteract && this.isMouseOver ? 2.0 : 0.0); // Show outline only in interactive mode
        this.gl.uniform2i(uTextureSize, this.canvas.width, this.canvas.height);
        this.gl.uniform1f(uAlpha, (!this.allowInteract && this.isMouseOver) ? 0.3 : 1.0); // Reduce opacity when non-interactive and mouse over

        // Bind framebuffer texture
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.framebufferTexture);

        // Draw quad to canvas
        const aPosition = this.gl.getAttribLocation(this.outlineShader, "a_position");
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quadBuffer);
        this.gl.enableVertexAttribArray(aPosition);
        this.gl.vertexAttribPointer(aPosition, 2, this.gl.FLOAT, false, 0, 0);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);

        // Store the animation frame ID
        this.animationFrameId = requestAnimationFrame(this.render.bind(this));
    }

    private turnDirection(current: Direction): Direction {
        return current === "left" ? "right" : "left";
    }

    private makeAction(animation: string, direction: Direction): Action {
        const behavior = BEHAVIORS[animation];
        return {
            animation,
            direction,
            timestamp: 0,
            duration: behavior.minSeconds + Math.random() * (behavior.maxSeconds - behavior.minSeconds),
        };
    }

    private nextAction(current: Action): Action {
        const weights = BEHAVIORS[current.animation].next;
        const choices = Object.keys(weights).filter(name => this.animationNames.includes(name));
        const total = choices.reduce((sum, name) => sum + weights[name], 0);

        let roll = Math.random() * total;
        let next = "Relax";
        for (const name of choices) {
            roll -= weights[name];
            if (roll <= 0) {
                next = name;
                break;
            }
        }

        const mayTurn = next === "Move" && Math.random() < 0.4;
        return this.makeAction(next, mayTurn ? this.turnDirection(current.direction) : current.direction);
    }

    private startAction(action: Action): void {
        const looping = !BEHAVIORS[action.animation].once;
        // Restarting a loop that is already playing would make it visibly hitch
        const alreadyPlaying = looping && action.animation === this.currentAction.animation;
        this.currentAction = action;
        if (!alreadyPlaying) {
            this.character.state.setAnimation(0, action.animation, looping);
        }
        console.debug("Play action", action);
    }

    private handleLoopComplete(): void {
        if (this.isDragging || this.currentAction.timestamp < this.currentAction.duration) {
            return;
        }
        this.startAction(this.nextAction(this.currentAction));
    }

    private handleCanvasClick(): void {
        if (!this.dragMoved) {
            this.interact();
        }
    }

    private interact(): void {
        if (this.character && this.animationNames.includes("Interact")) {
            this.startAction(this.makeAction("Interact", this.currentAction.direction));
        }
    }

    private beginDrag(clientX: number, clientY: number, time: number): void {
        this.isDragging = true;
        this.dragMoved = false;
        this.dragOriginX = clientX;
        this.dragOriginY = clientY;
        this.dragStartRelativeX = clientX - this.position.x;
        this.dragStartRelativeY = clientY - this.position.y;
        this.velocity = { x: 0, y: 0 };
        this.dragSamples = [{ x: clientX, y: clientY, time }];

        // Pause any current animation
        if (this.character) {
            this.startAction(this.makeAction("Relax", this.currentAction.direction));
        }
    }

    private moveDrag(clientX: number, clientY: number, timeStamp: number): void {
        const newX = clientX - this.dragStartRelativeX;
        const newY = clientY - this.dragStartRelativeY;

        this.dragSamples = this.dragSamples.filter(sample => timeStamp - sample.time <= THROW_SAMPLE_MS);
        this.dragSamples.push({ x: clientX, y: clientY, time: timeStamp });

        if (Math.hypot(clientX - this.dragOriginX, clientY - this.dragOriginY) > DRAG_SLOP) {
            this.dragMoved = true;
        }

        // Update position
        this.position.x = newX;
        this.position.y = newY;
        this.canvas.style.transform = `translate(${this.position.x}px, ${this.position.y}px)`;
    }

    private endDrag(event?: MouseEvent | TouchEvent): void {
        if (event && this.isDragging && this.dragMoved && event.type !== 'touchcancel') {
            const point = 'changedTouches' in event ? event.changedTouches[0] : event;
            const first = this.dragSamples.find(sample => event.timeStamp - sample.time <= THROW_SAMPLE_MS);
            if (point && first && event.timeStamp > first.time) {
                const seconds = (event.timeStamp - first.time) / 1000;
                this.velocity.x = (point.clientX - first.x) / seconds;
                this.velocity.y = (point.clientY - first.y) / seconds;
            }
        }
        this.isDragging = false;
        this.dragSamples = [];
    }

    private handleMouseDown(e: MouseEvent): void {
        if (e.button === 0) {
            e.preventDefault(); // don't start a text selection
            this.beginDrag(e.clientX, e.clientY, e.timeStamp);
        }
    }

    private handleMouseDrag(e: MouseEvent): void {
        if (this.isDragging) {
            this.moveDrag(e.clientX, e.clientY, e.timeStamp);
        }
    }

    private touchHitsPet(x: number, y: number): boolean {
        if (!this.character) {
            return false;
        }
        const r = TOUCH_HIT_RADIUS;
        return this.isOpaqueAt(x, y)
            || this.isOpaqueAt(x - r, y) || this.isOpaqueAt(x + r, y)
            || this.isOpaqueAt(x, y - r) || this.isOpaqueAt(x, y + r);
    }

    private clearLongPress(): void {
        if (this.longPressTimer !== null) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    }

    private handleTouchStart(e: TouchEvent): void {
        const target = e.target as Element | null;
        if (e.touches.length !== 1 || target?.closest?.('#arkpets-menu')) {
            return;
        }
        const touch = e.touches[0];
        if (!this.touchHitsPet(touch.clientX, touch.clientY)) {
            return;
        }

        e.preventDefault(); // no scrolling and no synthesized mouse events
        this.beginDrag(touch.clientX, touch.clientY, e.timeStamp);
        this.longPressFired = false;
        this.longPressTimer = window.setTimeout(() => {
            this.longPressTimer = null;
            this.longPressFired = true;
            this.endDrag();
            this.onContextMenu(e);
        }, LONG_PRESS_MS);
    }

    private handleTouchMove(e: TouchEvent): void {
        if (!this.isDragging) {
            return;
        }
        e.preventDefault();
        const touch = e.touches[0];
        this.moveDrag(touch.clientX, touch.clientY, e.timeStamp);
        if (this.dragMoved) {
            this.clearLongPress();
        }
    }

    private handleTouchEnd(e: TouchEvent): void {
        const wasDragging = this.isDragging;
        this.clearLongPress();
        this.endDrag(e);
        if (wasDragging && !this.dragMoved && !this.longPressFired) {
            this.interact();
        }
    }

    public destroy(): void {
        this.loadToken++; // abandon any load still in flight

        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.clearLongPress();

        // Remove event listeners
        this.listeners.abort();

        // Clean up Spine resources
        if (this.character) {
            this.character.state.clearTracks();
            this.character.state.clearListeners();
        }

        // Delete WebGL resources
        this.gl.deleteFramebuffer(this.framebuffer);
        this.gl.deleteTexture(this.framebufferTexture);
        this.gl.deleteBuffer(this.quadBuffer);
        this.gl.deleteProgram(this.outlineShader);

        // Clear session storage
        try {
            sessionStorage.removeItem(this.sessionKey());
        } catch (e) { /* nothing to clear */ }

        this.texture?.dispose();

        // Browsers limit the number of WebGL contexts, so release this one now
        this.gl.getExtension('WEBGL_lose_context')?.loseContext();

        // Remove canvas
        this.canvas.remove();
    }

    public getAnimationNames(): string[] {
        return this.animationNames;
    }

    public playAnimation(animationName: string): void {
        this.startAction(this.makeAction(animationName, this.currentAction.direction));
    }

    public getCanvasId(): string {
        return this.canvas.id;
    }

    public getModel(): CharacterModel {
        return this.model;
    }

    public isAllowInteract(): boolean {
        return this.allowInteract;
    }

    public setAllowInteract(allowInteract: boolean): void {
        this.allowInteract = allowInteract;
    }
}
