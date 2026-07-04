// ============================================================
// Teleobjetivo — pipeline WebGL completo
// Blur gaussiano -> aberración cromática radial -> curva de
// contraste tipo S (clipping de blancos/negros)
// ============================================================

const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl');
if (!gl) alert('Tu navegador no soporta WebGL.');

// ---------------- Shaders ----------------

const vertexSrc = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = (a_position + 1.0) * 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentSrc = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_image;
  uniform vec2 u_resolution;
  uniform float u_pixelAmount;    // 0..1  bloques tipo mosaico (baja resolución escalada)
  uniform float u_caAmount;       // 0..1  aberración cromática (sutil)
  uniform float u_contrastAmount; // 0..1  clipping de blancos/negros
  uniform float u_noiseAmount;    // 0..1  grano
  uniform float u_time;           // para variar el grano frame a frame en video

  // Pixelado tipo mosaico: cuantiza las coordenadas de textura a una grilla
  // de bloques. Esto simula una foto de baja resolución escalada hacia
  // arriba (el look de zoom digital estirado), a diferencia de un blur
  // continuo tipo gaussiano.
  vec2 pixelate(vec2 uv, vec2 resolution, float amount) {
    if (amount < 0.001) return uv;
    // tamaño de bloque en píxeles: de 1 (sin efecto) a ~10px
    float blockSize = 1.0 + amount * 9.0;
    vec2 blocks = resolution / blockSize;
    return floor(uv * blocks) / blocks;
  }

  vec4 sampleImage(sampler2D image, vec2 uv, vec2 resolution, float pixelAmount) {
    vec2 puv = pixelate(uv, resolution, pixelAmount);
    return texture2D(image, puv);
  }

  // --- Conversión RGB <-> YUV, para poder pixelar el color (croma) más
  // grueso que el brillo (luma), tal como hace la compresión de video real
  // (chroma subsampling 4:2:0 y similares).
  vec3 rgb2yuv(vec3 c) {
    float y = 0.299*c.r + 0.587*c.g + 0.114*c.b;
    float u = -0.14713*c.r - 0.28886*c.g + 0.436*c.b;
    float v = 0.615*c.r - 0.51499*c.g - 0.10001*c.b;
    return vec3(y, u, v);
  }
  vec3 yuv2rgb(vec3 c) {
    float r = c.x + 1.13983*c.z;
    float g = c.x - 0.39465*c.y - 0.58060*c.z;
    float b = c.x + 2.03211*c.y;
    return vec3(r, g, b);
  }

  // Muestrea luma con el bloque "normal" y croma con un bloque más grueso
  // (aprox el doble), recombinando en RGB. Esto da ese look de video de
  // baja resolución donde el color se ve más "manchado" que el detalle.
  vec4 sampleChromaSubsampled(sampler2D image, vec2 uv, vec2 resolution, float pixelAmount) {
    vec4 fine = sampleImage(image, uv, resolution, pixelAmount);
    if (pixelAmount < 0.001) return fine;

    float coarseAmount = min(1.0, pixelAmount * 1.8);
    vec4 coarse = sampleImage(image, uv, resolution, coarseAmount);

    vec3 yuvFine = rgb2yuv(fine.rgb);
    vec3 yuvCoarse = rgb2yuv(coarse.rgb);
    vec3 combined = vec3(yuvFine.x, yuvCoarse.y, yuvCoarse.z);
    return vec4(yuv2rgb(combined), fine.a);
  }

  // Aberración cromática radial sutil sobre la imagen ya pixelada
  // (con chroma subsampling aplicado).
  vec4 chromaticAberration(sampler2D image, vec2 uv, vec2 resolution, float amount, float pixelAmount) {
    if (amount < 0.001) {
      return sampleChromaSubsampled(image, uv, resolution, pixelAmount);
    }
    vec2 center = vec2(0.5, 0.5);
    vec2 dir = uv - center;
    float dist = length(dir);
    vec2 texel = 1.0 / resolution;
    float shift = amount * 6.0 * dist;
    vec2 offset = normalize(dir + 0.0001) * shift * texel;

    float r = sampleChromaSubsampled(image, uv + offset, resolution, pixelAmount).r;
    float g = sampleChromaSubsampled(image, uv, resolution, pixelAmount).g;
    float b = sampleChromaSubsampled(image, uv - offset, resolution, pixelAmount).b;
    float a = sampleChromaSubsampled(image, uv, resolution, pixelAmount).a;
    return vec4(r, g, b, a);
  }

  vec3 sCurveContrast(vec3 color, float amount) {
    vec3 c = color;
    c = (c - 0.5) * (1.0 + amount * 3.0) + 0.5;
    c = clamp(c, 0.0, 1.0);
    c = mix(c, smoothstep(vec3(0.0), vec3(1.0), c), amount);
    return c;
  }

  // Banding sutil: reduce la profundidad de color para simular la pérdida
  // de gradientes suaves típica de video muy comprimido. Fijo y discreto,
  // no depende de ningún slider.
  vec3 banding(vec3 color) {
    float levels = 48.0;
    vec3 quantized = floor(color * levels + 0.5) / levels;
    return mix(color, quantized, 0.25);
  }

  // Hash simple para ruido pseudoaleatorio por píxel/frame
  float hash(vec2 p, float seed) {
    return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453);
  }

  void main() {
    // el eje Y de las texturas está invertido respecto a <img>/<video>
    vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
    vec4 color = chromaticAberration(u_image, uv, u_resolution, u_caAmount, u_pixelAmount);
    color.rgb = sCurveContrast(color.rgb, u_contrastAmount);
    color.rgb = banding(color.rgb);

    if (u_noiseAmount > 0.001) {
      float n = (hash(gl_FragCoord.xy, u_time) - 0.5) * u_noiseAmount * 0.35;
      color.rgb += n;
    }

    gl_FragColor = color;
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Error compilando shader:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl, vertexSrc, fragmentSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Error enlazando programa:', gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

const program = createProgram(gl, vertexSrc, fragmentSrc);
gl.useProgram(program);

// Quad que cubre todo el canvas
const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1, -1,  1, -1,  -1, 1,
  -1,  1,  1, -1,   1, 1,
]), gl.STATIC_DRAW);
const positionLoc = gl.getAttribLocation(program, 'a_position');
gl.enableVertexAttribArray(positionLoc);
gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

// Textura
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

const imageLoc = gl.getUniformLocation(program, 'u_image');
const resolutionLoc = gl.getUniformLocation(program, 'u_resolution');
const pixelAmountLoc = gl.getUniformLocation(program, 'u_pixelAmount');
const caAmountLoc = gl.getUniformLocation(program, 'u_caAmount');
const contrastAmountLoc = gl.getUniformLocation(program, 'u_contrastAmount');
const noiseAmountLoc = gl.getUniformLocation(program, 'u_noiseAmount');
const timeLoc = gl.getUniformLocation(program, 'u_time');

// ---------------- Estado de modos ----------------

let mode = 'photo';
let currentImage = null;   // usado en modo foto
let mediaStream = null;
let rafId = null;
let mediaRecorder = null;
let recordedChunks = [];
let usingVideoSource = false; // true en modo video/cámara (hay que refrescar textura cada frame)

const video = document.getElementById('video');
const dropzone = document.getElementById('dropzone');
const camStart = document.getElementById('camStart');
const fileInput = document.getElementById('fileInput');
const photoBtn = document.getElementById('photoBtn');
const recordBtn = document.getElementById('recordBtn');
const note = document.getElementById('note');
const camStartBtn = document.getElementById('camStartBtn');

// ---------------- Render ----------------

function render() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform1i(imageLoc, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.uniform2f(resolutionLoc, canvas.width, canvas.height);

  const pixelSlider = document.getElementById('pixelSlider');
  const caSlider = document.getElementById('caSlider');
  const contrastSlider = document.getElementById('contrastSlider');
  const noiseSlider = document.getElementById('noiseSlider');

  gl.uniform1f(pixelAmountLoc, pixelSlider.value / 100);
  gl.uniform1f(caAmountLoc, caSlider.value / 100);
  gl.uniform1f(contrastAmountLoc, contrastSlider.value / 100);
  gl.uniform1f(noiseAmountLoc, noiseSlider.value / 100);
  gl.uniform1f(timeLoc, performance.now() / 1000);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawImageToCanvas(image) {
  currentImage = image;
  const maxW = 700;
  const scale = Math.min(1, maxW / image.width);
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  render();
}

function setupCanvasForVideo() {
  const maxW = 640;
  const scale = Math.min(1, maxW / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
}

function startFrameLoop() {
  function loop() {
    if (video.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      render();
    }
    rafId = requestAnimationFrame(loop);
  }
  loop();
}

// ---------------- Sliders (re-renderizan en modo foto; en video/cámara el loop ya renderiza cada frame) ----------------

['pixelSlider', 'caSlider', 'contrastSlider', 'noiseSlider'].forEach((id) => {
  const el = document.getElementById(id);
  const out = document.getElementById(id.replace('Slider', 'Val'));
  el.addEventListener('input', () => {
    out.textContent = el.value;
    if (mode === 'photo' && currentImage) render();
  });
});

// ---------------- Modo foto ----------------

function handleImageFile(file) {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      canvas.style.display = 'block';
      dropzone.style.display = 'none';
      drawImageToCanvas(img);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (mode === 'photo') handleImageFile(file);
  else if (mode === 'video') handleVideoFile(file);
});
dropzone.addEventListener('click', () => fileInput.click());
['dragover', 'dragenter'].forEach((evt) => dropzone.addEventListener(evt, (e) => e.preventDefault()));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (mode === 'photo') handleImageFile(file);
  else if (mode === 'video') handleVideoFile(file);
});

// ---------------- Modo video ----------------

function handleVideoFile(file) {
  if (!file.type.startsWith('video/')) return;
  video.src = URL.createObjectURL(file);
  video.loop = true;
  video.onloadedmetadata = () => {
    dropzone.style.display = 'none';
    canvas.style.display = 'block';
    usingVideoSource = true;
    setupCanvasForVideo();
    video.play();
    startFrameLoop();
  };
}

// ---------------- Modo cámara ----------------

camStartBtn.addEventListener('click', async () => {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    video.srcObject = mediaStream;
    video.onloadedmetadata = () => {
      camStart.style.display = 'none';
      canvas.style.display = 'block';
      usingVideoSource = true;
      setupCanvasForVideo();
      video.play();
      startFrameLoop();
    };
  } catch (err) {
    note.textContent = 'No se pudo acceder a la cámara: ' + err.message;
  }
});

// ---------------- Cambio de pestañas ----------------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

function stopEverything() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  video.pause();
  video.srcObject = null;
  video.src = '';
  currentImage = null;
  usingVideoSource = false;
}

function switchMode(newMode) {
  stopEverything();
  mode = newMode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  dropzone.style.display = 'none';
  camStart.style.display = 'none';
  canvas.style.display = 'none';
  fileInput.value = '';
  note.textContent = '';

  if (mode === 'photo') {
    dropzone.querySelector('strong').textContent = 'Cargar fotografía';
    fileInput.setAttribute('accept', 'image/*');
    dropzone.style.display = 'flex';
  } else if (mode === 'video') {
    dropzone.querySelector('strong').textContent = 'Cargar video';
    fileInput.setAttribute('accept', 'video/*');
    dropzone.style.display = 'flex';
  } else if (mode === 'camera') {
    camStart.style.display = 'block';
    note.textContent = 'La cámara se procesa localmente en tu navegador, no se sube a ningún servidor.';
  }
}

// ---------------- Botones ----------------

// ---------------- Guardar en galería (Web Share API con fallback a descarga) ----------------
// En móvil, navigator.share con un archivo abre el diálogo nativo de
// compartir/guardar, donde el usuario puede elegir "Guardar en Fotos" o
// equivalente. Si el navegador no lo soporta (ej. desktop), caemos a una
// descarga normal.

async function saveBlob(blob, filename, mimeType) {
  const file = new File([blob], filename, { type: mimeType });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------- Botones ----------------

photoBtn.addEventListener('click', () => {
  canvas.toBlob((blob) => {
    if (blob) saveBlob(blob, 'teleobjetivo.png', 'image/png');
  }, 'image/png');
});

recordBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    recordBtn.textContent = '⏺ Grabar video';
    return;
  }
  const stream = canvas.captureStream(30);
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    saveBlob(blob, 'teleobjetivo.webm', 'video/webm');
  };
  mediaRecorder.start();
  recordBtn.textContent = '⏹ Detener grabación';
});