// Read only the XR8 camera texture, before scene rendering. No second camera
// stream, screenshot, network request, persistent image, or texture-provider change.
// XR8's projection matrix describes the canvas-cropped camera feed:
// https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule
// https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu

export function cardPointCaptureGeometry(canvasWidth, canvasHeight, viewport, maxDimension = 640) {
  if (![canvasWidth, canvasHeight, viewport?.width, viewport?.height].every(
    (value) => Number.isFinite(value) && value > 0,
  )) return null;
  const limit = Math.max(1, Math.min(640, Math.floor(Number(maxDimension) || 640)));
  const scale = Math.min(1, limit / Math.max(canvasWidth, canvasHeight));
  const width = Math.max(1, Math.round(canvasWidth * scale));
  const height = Math.max(1, Math.round(canvasHeight * scale));
  // WebGL converts viewport arguments to integer pixels. Match the display's
  // actual crop, including its occasionally asymmetric one-pixel rounding.
  const vp = {
    width: Math.trunc(viewport.width),
    height: Math.trunc(viewport.height),
    offsetX: Math.trunc(viewport.offsetX || 0),
    offsetY: Math.trunc(viewport.offsetY || 0),
  };
  if (vp.width < 1 || vp.height < 1
      || !Number.isFinite(vp.offsetX) || !Number.isFinite(vp.offsetY)) return null;
  const top = canvasHeight - vp.offsetY - vp.height;
  return {
    width, height,
    // UV = offset + output-normalized-xy * span. Output y=0 is the TOP.
    uvTransform: [-vp.offsetX / vp.width, -top / vp.height,
      canvasWidth / vp.width, canvasHeight / vp.height],
  };
}

function vertexArrayApi(gl) {
  if (gl.createVertexArray && gl.bindVertexArray && gl.VERTEX_ARRAY_BINDING !== undefined) {
    return {
      binding: gl.VERTEX_ARRAY_BINDING,
      create: () => gl.createVertexArray(),
      bind: (value) => gl.bindVertexArray(value),
      remove: (value) => gl.deleteVertexArray(value),
    };
  }
  const ext = gl.getExtension("OES_vertex_array_object");
  if (!ext) throw new Error("Card-point camera requires a vertex array object.");
  return {
    binding: ext.VERTEX_ARRAY_BINDING_OES,
    create: () => ext.createVertexArrayOES(),
    bind: (value) => ext.bindVertexArrayOES(value),
    remove: (value) => ext.deleteVertexArrayOES(value),
  };
}

// Deliberately save every state this pass changes. XR8's convenience save helper
// does not preserve separate WebGL2 read/draw FBOs, pixel-pack state or samplers.
function preserveGlState(gl, vao) {
  const state = {
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    vao: gl.getParameter(vao.binding),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
    pack: gl.getParameter(gl.PACK_ALIGNMENT),
    enabled: ["BLEND", "DEPTH_TEST", "CULL_FACE", "SCISSOR_TEST", "STENCIL_TEST",
      "DITHER", "SAMPLE_ALPHA_TO_COVERAGE", "SAMPLE_COVERAGE", "RASTERIZER_DISCARD"]
      .filter((name) => gl[name] !== undefined)
      .map((name) => [gl[name], gl.isEnabled(gl[name])]),
  };
  gl.activeTexture(gl.TEXTURE0);
  state.texture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
  if (gl.READ_FRAMEBUFFER !== undefined) {
    state.webgl2 = {
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      packBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
      unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
      sampler0: gl.getParameter(gl.SAMPLER_BINDING),
      rowLength: gl.getParameter(gl.PACK_ROW_LENGTH),
      skipPixels: gl.getParameter(gl.PACK_SKIP_PIXELS),
      skipRows: gl.getParameter(gl.PACK_SKIP_ROWS),
    };
  }
  return () => {
    vao.bind(state.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
    gl.useProgram(state.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.texture0);
    gl.activeTexture(state.activeTexture);
    gl.viewport(...state.viewport);
    gl.colorMask(...state.colorMask);
    gl.pixelStorei(gl.PACK_ALIGNMENT, state.pack);
    for (const [cap, enabled] of state.enabled) gl[enabled ? "enable" : "disable"](cap);
    if (state.webgl2) {
      const s = state.webgl2;
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.draw);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.read);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.packBuffer);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, s.unpackBuffer);
      gl.bindSampler(0, s.sampler0);
      gl.pixelStorei(gl.PACK_ROW_LENGTH, s.rowLength);
      gl.pixelStorei(gl.PACK_SKIP_PIXELS, s.skipPixels);
      gl.pixelStorei(gl.PACK_SKIP_ROWS, s.skipRows);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
  };
}

function compileShader(gl, kind, source) {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error("Card-point camera shader allocation failed.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error("Card-point camera shader compilation failed.");
  }
  return shader;
}

function createReader(gl) {
  const vao = vertexArrayApi(gl);
  let program, buffer, vertexArray, texture, framebuffer;
  let outputWidth = 0, outputHeight = 0;
  const destroy = () => {
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    if (vertexArray) vao.remove(vertexArray);
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    program = buffer = vertexArray = texture = framebuffer = null;
  };
  const restore = preserveGlState(gl, vao);
  let vertexShader, fragmentShader;
  try {
    vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 position;
      varying vec2 imageUv;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
        imageUv = (position + 1.0) * 0.5;
      }`);
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D cameraImage;
      uniform vec4 uvTransform;
      varying vec2 imageUv;
      void main() {
        gl_FragColor = texture2D(cameraImage,
          uvTransform.xy + imageUv * uvTransform.zw);
      }`);
    program = gl.createProgram();
    if (!program) throw new Error("Card-point camera program allocation failed.");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.bindAttribLocation(program, 0, "position");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("Card-point camera shader linking failed.");
    }
    vertexArray = vao.create();
    buffer = gl.createBuffer();
    texture = gl.createTexture();
    framebuffer = gl.createFramebuffer();
    if (!vertexArray || !buffer || !texture || !framebuffer) {
      throw new Error("Card-point camera GPU allocation failed.");
    }
    vao.bind(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } catch (error) {
    destroy();
    throw error;
  } finally {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    restore();
  }
  const samplerLocation = gl.getUniformLocation(program, "cameraImage");
  const transformLocation = gl.getUniformLocation(program, "uvTransform");
  return {
    destroy,
    read(cameraTexture, geometry) {
      const reset = preserveGlState(gl, vao);
      const { width, height, uvTransform } = geometry;
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        if (gl.PIXEL_PACK_BUFFER !== undefined) {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
          gl.bindSampler(0, null);
          gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
          gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
          gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
        }
        if (width !== outputWidth || height !== outputHeight) {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, texture, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error("Card-point camera framebuffer is incomplete.");
          }
          outputWidth = width;
          outputHeight = height;
        }
        for (const name of ["BLEND", "DEPTH_TEST", "CULL_FACE", "SCISSOR_TEST", "STENCIL_TEST",
          "DITHER", "SAMPLE_ALPHA_TO_COVERAGE", "SAMPLE_COVERAGE", "RASTERIZER_DISCARD"]) {
          if (gl[name] !== undefined) gl.disable(gl[name]);
        }
        gl.colorMask(true, true, true, true);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        vao.bind(vertexArray);
        gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
        gl.uniform1i(samplerLocation, 0);
        gl.uniform4fv(transformLocation, uvTransform);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const data = new Uint8Array(width * height * 4);
        // The shader intentionally writes the image top to FBO row zero:
        // readPixels is bottom-up, but the returned array is top-left RGBA.
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      } finally {
        reset();
      }
    },
  };
}

function copyCamera(reality) {
  const p = reality?.position;
  const q = reality?.rotation;
  const m = reality?.intrinsics;
  if (m?.length !== 16 || !Array.from(m).every(Number.isFinite)
      || ![p?.x, p?.y, p?.z, q?.x, q?.y, q?.z, q?.w].every(Number.isFinite)) return null;
  return {
    projectionMatrix: Array.from(m),
    cameraPosition: { x: p.x, y: p.y, z: p.z },
    cameraQuaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
  };
}

export function createCardPointCamera({
  onFrame, onError = () => {}, isEnabled = () => true,
  maxDimension = 640, intervalMs = 125,
  now = () => globalThis.performance.now(),
  document = globalThis.document,
} = {}) {
  if (typeof onFrame !== "function") throw new TypeError("Card-point camera requires onFrame.");
  let gl = null, reader = null, attached = false, paused = false, disposed = false;
  let failed = false, busy = false, lastCapture = -Infinity, lastVideoTime = null;
  let sequence = 0, generation = 0;
  const interval = Math.max(100, Number(intervalMs) || 125);
  const release = () => {
    reader?.destroy();
    reader = null;
    gl = null;
    generation += 1;
    lastCapture = -Infinity;
    lastVideoTime = null;
  };
  const invalidate = () => {
    generation += 1;
    lastVideoTime = null;
  };
  const visibilityChanged = () => { invalidate(); lastCapture = -Infinity; };
  const report = (error) => {
    try { onError(error); } catch { /* Diagnostics must not stop XR8. */ }
  };
  const module = {
    name: "flowarcardpointcamera",
    onAttach: () => {
      attached = true; paused = false; failed = false;
      document?.addEventListener?.("visibilitychange", visibilityChanged);
    },
    onDetach: () => {
      attached = false; release();
      document?.removeEventListener?.("visibilitychange", visibilityChanged);
    },
    onRemove: () => {
      attached = false; release();
      document?.removeEventListener?.("visibilitychange", visibilityChanged);
    },
    onPaused: () => { paused = true; invalidate(); },
    onResume: () => { paused = false; lastCapture = -Infinity; invalidate(); },
    onDeviceOrientationChange: invalidate,
    onCanvasSizeChange: invalidate,
    onVideoSizeChange: invalidate,
    onUpdate: ({ frameStartResult, processGpuResult, processCpuResult } = {}) => {
      if (!attached || disposed || paused || failed || busy || document?.hidden || !isEnabled()) return;
      const frame = frameStartResult;
      const reality = processCpuResult?.reality;
      const camera = copyCamera(reality);
      const captureTime = now();
      if (!frame || frame.repeatFrame || !camera || !reality.realityTexture
          || captureTime - lastCapture < interval
          || (frame.videoTime != null && frame.videoTime === lastVideoTime)) return;
      const context = frame.GLctx;
      if (!context || context.isContextLost?.()) return;
      // Use the EXACT display viewport and realityTexture from this XR8 frame.
      // Do not independently rotate by frame.orientation: XR8 already applies
      // its orientation consistently to this texture, viewport and projection.
      const geometry = cardPointCaptureGeometry(context.drawingBufferWidth,
        context.drawingBufferHeight, processGpuResult?.gltexturerenderer?.viewport, maxDimension);
      if (!geometry) return;
      let data;
      try {
        if (context !== gl) { release(); gl = context; }
        reader ||= createReader(gl);
        data = reader.read(reality.realityTexture, geometry);
      } catch (error) {
        failed = true;
        report(error);
        return;
      }
      lastCapture = captureTime;
      lastVideoTime = frame.videoTime;
      busy = true;
      const currentGeneration = generation;
      const payload = {
        data, width: geometry.width, height: geometry.height,
        ...camera, capturedAt: captureTime, sequence: ++sequence,
        videoTime: frame.videoTime, orientation: frame.orientation,
        // The consumer can discard a worker result after a resize/pause/detach.
        isCurrent: () => currentGeneration === generation && attached && !disposed
          && !paused && !document?.hidden && isEnabled(),
      };
      try {
        Promise.resolve(onFrame(payload)).catch(report).finally(() => { busy = false; });
      } catch (error) {
        busy = false;
        report(error);
      }
    },
  };
  return {
    pipelineModule: () => module,
    dispose: () => {
      disposed = true; attached = false; release();
      document?.removeEventListener?.("visibilitychange", visibilityChanged);
    },
  };
}
