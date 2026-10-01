import * as THREE from '/vendor/three.module.js';

const grid = document.querySelector('#video-grid');
const count = document.querySelector('#library-count');
const search = document.querySelector('#search');
const emptyState = document.querySelector('#empty-state');
const message = document.querySelector('#message');
const player = document.querySelector('#player');
const renderArea = document.querySelector('#render-area');
const video = document.querySelector('#video');
const xrStatus = document.querySelector('#xr-status');
const projectionInput = document.querySelector('#projection');
const stereoInput = document.querySelector('#stereo');
const panel = document.querySelector('#player-panel');
const seekInput = document.querySelector('#seek');
const seekPreview = document.querySelector('#seek-preview');
const seekPreviewCanvas = document.querySelector('#seek-preview-frame');
const seekPreviewContext = seekPreviewCanvas.getContext('2d');
const seekPreviewVideo = document.createElement('video');
const raycaster = new THREE.Raycaster();
const grabViewPosition = new THREE.Vector3();
const grabViewUp = new THREE.Vector3(0, 1, 0);
const MIN_SCREEN_DISTANCE = 3.2;
const MAX_SCREEN_DISTANCE = 20;
const videos = [];
const thumbnailCache = new Map();
const thumbnailRequests = new Map();
let activeVideo = null;
let projection = 'cinema';
let stereo = 'mono';
let texture;
let screen;
let sphere;
let panelMesh;
let panelTexture;
let panelContext;
let panelHitboxes = [];
let xrActive = false;
let seeking = false;
let aspect = 16 / 9;
let cataloguePage = 0;
let collectionVisible = false;
let xrAnchored = false;
let playbackNotice = '';
let controlsVisible = false;
let seekPreviewSource = '';
let seekPreviewTarget = 0;
let seekPreviewLoading = false;
let seekPreviewRequestedTarget = 0;
let seekPreviewHasFrame = false;
let vrSeekPreviewVisible = false;
let vrSeekPreviewFraction = 0;
let vrPreviewAnimationStep = -1;
let dragPointerId = null;
let dragLastX = 0;
let dragLastY = 0;
let dragYaw = 0;
let dragPitch = 0;
let debugEnabled = false;
let debugFrameCount = 0;
let debugLastUpdate = performance.now();
let debugFps = 0;
let debugVideoFps = 0;
let debugLastVideoFrames = null;
let screenGrab = null;
let xrReferenceSpace = null;
let xrSession = null;
let debugMediaStatus = 'idle';
const vrDebugEvents = [];
let xrVisibilityState = 'not in session';
seekPreviewVideo.muted = true;
seekPreviewVideo.preload = 'metadata';
seekPreviewVideo.playsInline = true;
seekPreviewVideo.addEventListener('loadeddata', () => {
  seekPreviewContext.drawImage(
    seekPreviewVideo,
    0,
    0,
    seekPreviewCanvas.width,
    seekPreviewCanvas.height,
  );
  seekPreviewHasFrame = true;
  if (Math.abs(seekPreviewVideo.currentTime - seekPreviewTarget) > 0.2) seekPreviewAtTarget();
  else seekPreviewLoading = false;
  if (vrSeekPreviewVisible) drawVrPanel();
});
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
camera.position.set(0, 1.62, 0);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderArea.appendChild(renderer.domElement);
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (
    renderer.xr.isPresenting ||
    !activeVideo ||
    projection === 'flat' ||
    !event.isPrimary ||
    event.button > 0
  )
    return;
  dragPointerId = event.pointerId;
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  renderer.domElement.setPointerCapture(event.pointerId);
  renderArea.classList.add('dragging');
  event.preventDefault();
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (dragPointerId !== event.pointerId || renderer.xr.isPresenting) return;
  const dx = event.clientX - dragLastX;
  const dy = event.clientY - dragLastY;
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  dragYaw -= dx * 0.004;
  dragPitch = THREE.MathUtils.clamp(
    dragPitch - dy * 0.004,
    -Math.PI / 2 + 0.08,
    Math.PI / 2 - 0.08,
  );
  camera.rotation.order = 'YXZ';
  camera.rotation.set(dragPitch, dragYaw, 0);
  event.preventDefault();
});
const endDrag = (event) => {
  if (dragPointerId !== event.pointerId) return;
  dragPointerId = null;
  renderArea.classList.remove('dragging');
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
renderer.domElement.addEventListener('lostpointercapture', endDrag);

const videoUniforms = {
  map: { value: null },
  uLayout: { value: 0 },
  uEye: { value: 0 },
};
const videoMaterial = new THREE.ShaderMaterial({
  uniforms: videoUniforms,
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D map; uniform int uLayout; uniform int uEye; varying vec2 vUv;
    void main(){ vec2 uv=vUv; if(uLayout==1){ uv.x=uv.x*0.5+float(uEye)*0.5; } else if(uLayout==2){ uv.y=uv.y*0.5+float(1-uEye)*0.5; } gl_FragColor=texture2D(map,uv); }
  `,
  side: THREE.DoubleSide,
  toneMapped: false,
});
const flatVideoMaterial = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide,
  toneMapped: false,
});
videoMaterial.onBeforeRender = (activeRenderer, _scene, activeCamera) => {
  const eyeCameras = activeRenderer.xr.getCamera().cameras;
  const eye = eyeCameras.indexOf(activeCamera);
  videoUniforms.uEye.value = eye === 1 ? 1 : 0;
};

const screenGeometry = new THREE.PlaneGeometry(3.5, 1.97);
screen = new THREE.Mesh(screenGeometry, flatVideoMaterial);
screen.position.set(0, 1.62, -6);
scene.add(screen);

function createCinemaScreenGeometry() {
  const radius = 3.4;
  const arc = 1.75;
  const width = radius * arc;
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    width / aspect,
    64,
    1,
    true,
    Math.PI + arc / 2,
    -arc,
  );
  geometry.translate(0, 0, radius);
  return geometry;
}

const sphereGeometry = new THREE.SphereGeometry(18, 64, 40, Math.PI, Math.PI, 0, Math.PI);
sphereGeometry.scale(-1, 1, 1);
sphere = new THREE.Mesh(sphereGeometry, flatVideoMaterial);
sphere.position.set(0, 1.62, 0);
sphere.visible = false;
scene.add(sphere);

const panelCanvas = document.createElement('canvas');
panelCanvas.width = 1024;
panelCanvas.height = 520;
panelContext = panelCanvas.getContext('2d');
panelTexture = new THREE.CanvasTexture(panelCanvas);
panelTexture.colorSpace = THREE.SRGBColorSpace;
const panelMaterial = new THREE.MeshBasicMaterial({
  map: panelTexture,
  transparent: true,
  side: THREE.DoubleSide,
  depthWrite: false,
});
panelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.82), panelMaterial);
panelMesh.position.set(0, 1.55, -1.55);
panelMesh.renderOrder = 4;
panelMesh.visible = false;
scene.add(panelMesh);

const controllers = [];
const pointerDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.012, 10, 10),
  new THREE.MeshBasicMaterial({ color: 0xd9ccff }),
);
pointerDot.visible = false;
scene.add(pointerDot);
for (let index = 0; index < 2; index += 1) {
  const controller = renderer.xr.getController(index);
  const gripController = renderer.xr.getControllerGrip(index);
  controller.addEventListener('select', onControllerSelect);
  controller.addEventListener('selectstart', () =>
    recordVrEvent(`${controller.userData.inputSource?.handedness || 'unknown'} trigger down`),
  );
  controller.addEventListener('selectend', () =>
    recordVrEvent(`${controller.userData.inputSource?.handedness || 'unknown'} trigger up`),
  );
  gripController.addEventListener('squeezestart', (event) => {
    recordVrEvent(`${gripController.userData.inputSource?.handedness || 'unknown'} squeeze start`);
    onScreenGrabStart(event);
  });
  gripController.addEventListener('squeezeend', (event) => {
    recordVrEvent(`${gripController.userData.inputSource?.handedness || 'unknown'} squeeze end`);
    onScreenGrabEnd(event);
  });
  controller.addEventListener('connected', (event) => {
    controller.userData.inputSource = event.data;
    gripController.userData.inputSource = event.data;
    const source = event.data;
    recordVrEvent(
      `input ${source.handedness} profile=${source.profiles.join(',')} map=${source.gamepad?.mapping || 'none'} buttons=${source.gamepad?.buttons.length ?? 0}`,
    );
  });
  controller.addEventListener('disconnected', (event) => {
    if (screenGrab?.controller === gripController) onScreenGrabEnd({ target: gripController });
    recordVrEvent(`input ${controller.userData.inputSource?.handedness || 'unknown'} disconnected`);
    delete controller.userData.inputSource;
    delete gripController.userData.inputSource;
  });
  scene.add(controller);
  scene.add(gripController);
  const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xb8a4ff, transparent: true, opacity: 0.85 }),
  );
  line.scale.z = 2;
  controller.add(line);
  controllers.push(controller);
}

window.addEventListener('resize', resize);
resize();
loadLibrary();
checkXR();
drawVrPanel();
renderer.setAnimationLoop(render);

document.querySelector('#refresh-button').addEventListener('click', loadLibrary);
search.addEventListener('input', renderLibrary);
document.querySelector('#back-button').addEventListener('click', closePlayer);
document.querySelector('#close-player').addEventListener('click', closePlayer);
document.querySelector('#player-enter-vr').addEventListener('click', enterXR);
document.querySelector('#fullscreen-button').addEventListener('click', toggleFullscreen);
document
  .querySelector('#debug-toggle')
  .addEventListener('click', () => setDebugEnabled(!debugEnabled));
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('keydown', (event) => {
  if (xrActive && (event.key === 'Home' || event.code === 'Home'))
    recordVrEvent('DOM keydown Home');
});
window.addEventListener('blur', () => {
  if (xrActive) recordVrEvent('window blur');
});
window.addEventListener('focus', () => {
  if (xrActive) recordVrEvent('window focus');
});
document.querySelector('#panel-hide').addEventListener('click', () => setPanelVisible(false));
document.querySelector('#panel-show').addEventListener('click', () => setPanelVisible(true));
document.querySelector('#play-pause').addEventListener('click', togglePlayback);
document.querySelector('#mute').addEventListener('click', () => {
  video.muted = !video.muted;
  updatePlaybackUi();
});
projectionInput.addEventListener('change', () => {
  projection = projectionInput.value;
  updateProjection();
  drawVrPanel();
});
stereoInput.addEventListener('change', () => {
  stereo = stereoInput.value;
  updateStereo();
  drawVrPanel();
});
seekInput.addEventListener('input', () => {
  seeking = true;
  if (Number.isFinite(video.duration))
    video.currentTime = (Number(seekInput.value) / 1000) * video.duration;
});
seekInput.addEventListener('change', () => {
  seeking = false;
});
seekInput.addEventListener('pointerenter', updateSeekPreview);
seekInput.addEventListener('pointermove', updateSeekPreview);
seekInput.addEventListener('pointerleave', () => seekPreview.classList.add('hidden'));
seekPreviewVideo.addEventListener('loadedmetadata', seekPreviewAtTarget);
seekPreviewVideo.addEventListener('seeked', () => {
  seekPreviewLoading = false;
  if (Math.abs(seekPreviewVideo.currentTime - seekPreviewTarget) > 0.35) {
    seekPreviewAtTarget();
    return;
  }
  if (seekPreviewVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    seekPreviewContext.drawImage(
      seekPreviewVideo,
      0,
      0,
      seekPreviewCanvas.width,
      seekPreviewCanvas.height,
    );
    seekPreviewHasFrame = true;
  }
  if (vrSeekPreviewVisible) drawVrPanel();
});
video.addEventListener('loadedmetadata', () => {
  aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  if (projection === 'cinema') updateProjection();
  else screen.scale.set(aspect / (16 / 9), 1, 1);
  if (texture) texture.dispose();
  texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  videoUniforms.map.value = texture;
  flatVideoMaterial.map = texture;
  flatVideoMaterial.needsUpdate = true;
  applyVideoMaterial();
  drawVrPanel();
});
video.addEventListener('timeupdate', updatePlaybackUi);
video.addEventListener('play', updatePlaybackUi);
video.addEventListener('pause', updatePlaybackUi);
video.addEventListener('ended', updatePlaybackUi);
video.addEventListener('waiting', () => {
  debugMediaStatus = 'waiting for data';
});
video.addEventListener('stalled', () => {
  debugMediaStatus = 'network stalled';
});
video.addEventListener('playing', () => {
  debugMediaStatus = 'playing';
  updatePlaybackUi();
});
video.addEventListener('error', () => {
  debugMediaStatus = 'media error';
});
video.addEventListener('error', () => {
  playbackNotice = 'This video could not be decoded. Try MP4 with H.264 video and AAC audio.';
  document.querySelector('#panel-note').textContent = playbackNotice;
  drawVrPanel();
});
renderer.xr.addEventListener('sessionstart', () => {
  // The flat immersive view can carry a desktop drag-look rotation. Clear it
  // before anchoring the screen so the initial XR center follows the headset.
  camera.rotation.set(0, 0, 0);
  screenGrab = null;
  xrActive = true;
  xrVisibilityState = renderer.xr.getSession()?.visibilityState || 'unknown';
  recordVrEvent(`session start visibility=${xrVisibilityState}`);
  document.querySelector('#debug-overlay').classList.add('hidden');
  player.classList.add('xr-mode');
  panel.classList.remove('xr-hidden');
  controlsVisible = !activeVideo || debugEnabled;
  panelMesh.visible = controlsVisible;
  document.querySelector('#panel-show').classList.add('hidden');
  document.querySelector('#player-enter-vr').classList.add('hidden');
  drawVrPanel();
  xrAnchored = false;
  xrReferenceSpace = renderer.xr.getReferenceSpace();
  xrReferenceSpace?.addEventListener('reset', onXRReferenceSpaceReset);
  xrSession = renderer.xr.getSession();
  xrSession?.addEventListener('visibilitychange', onXRSessionVisibilityChange);
  xrSession?.addEventListener('inputsourceschange', (event) => {
    for (const source of event.added) {
      recordVrEvent(`source added ${source.handedness} profile=${source.profiles.join(',')}`);
    }
    for (const source of event.removed) recordVrEvent(`source removed ${source.handedness}`);
  });
});
renderer.xr.addEventListener('sessionend', () => {
  recordVrEvent('session end');
  xrReferenceSpace?.removeEventListener('reset', onXRReferenceSpaceReset);
  xrReferenceSpace = null;
  xrSession?.removeEventListener('visibilitychange', onXRSessionVisibilityChange);
  xrSession = null;
  xrActive = false;
  screenGrab = null;
  document.querySelector('#debug-overlay').classList.toggle('hidden', !debugEnabled);
  player.classList.remove('xr-mode');
  panel.classList.remove('xr-hidden');
  panelMesh.visible = false;
  controlsVisible = true;
  document.querySelector('#panel-show').classList.add('hidden');
  document.querySelector('#player-enter-vr').classList.remove('hidden');
  if (debugEnabled) document.querySelector('#debug-overlay').textContent = getDebugOutput();
});
renderer.domElement.addEventListener('click', (event) => {
  if (!renderer.xr.isPresenting) return;
  const open = !panelMesh.visible;
  const point = open && activeVideo ? getCanvasVideoHit(event)?.point : undefined;
  if (open && !activeVideo) positionVrPanel();
  setVrControlsVisible(open, point);
});

async function loadLibrary() {
  count.textContent = 'Loading library';
  try {
    const response = await fetch('/api/videos', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Library request failed (${response.status})`);
    const data = await response.json();
    videos.splice(0, videos.length, ...(Array.isArray(data.videos) ? data.videos : []));
    cataloguePage = Math.min(cataloguePage, Math.max(0, Math.ceil(videos.length / 6) - 1));
    count.textContent = `${videos.length} VIDEO${videos.length === 1 ? '' : 'S'}`;
    message.classList.add('hidden');
    renderLibrary();
    drawVrPanel();
  } catch (error) {
    count.textContent = 'LIBRARY OFFLINE';
    showMessage(`Could not load the video library. ${error.message}`);
  }
}

function renderLibrary() {
  const query = search.value.trim().toLowerCase();
  const filtered = videos.filter((item) =>
    `${item.name} ${item.folder}`.toLowerCase().includes(query),
  );
  grid.replaceChildren(
    ...filtered.map((item, index) => {
      const button = document.createElement('button');
      button.className = 'video-card';
      button.type = 'button';
      button.setAttribute('aria-label', `Play ${item.name}`);
      const art = document.createElement('div');
      art.className = 'card-art';
      const thumbnail = document.createElement('img');
      thumbnail.className = 'card-thumbnail';
      thumbnail.alt = '';
      thumbnail.setAttribute('aria-hidden', 'true');
      const showThumbnail = async () => {
        try {
          const image = await getVideoThumbnail(item);
          thumbnail.src = image.src;
          art.classList.add('has-thumbnail');
        } catch {
          // Keep the generated artwork as a fallback when this browser cannot decode the file.
        }
      };
      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect();
            showThumbnail();
          }
        });
        observer.observe(art);
      } else showThumbnail();
      const number = document.createElement('span');
      number.className = 'card-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const play = document.createElement('span');
      play.className = 'card-play';
      play.textContent = '▶';
      art.append(thumbnail, number, play);
      const copy = document.createElement('div');
      copy.className = 'card-copy';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'card-meta';
      const folder = document.createElement('span');
      folder.className = 'card-folder';
      folder.textContent = item.folder || 'VIDEO';
      const size = document.createElement('span');
      size.textContent = formatSize(item.size);
      meta.append(folder, size);
      copy.append(title, meta);
      button.append(art, copy);
      button.addEventListener('click', () => playVideo(item));
      return button;
    }),
  );
  emptyState.classList.toggle('hidden', filtered.length > 0);
  if (!videos.length)
    emptyState.querySelector('p').innerHTML =
      'Add MP4 videos to the <code>videos/</code> folder, then refresh the library.';
  else if (!filtered.length)
    emptyState.querySelector('p').textContent = 'No videos match that search.';
}

function playVideo(item) {
  activeVideo = item;
  collectionVisible = false;
  playbackNotice = '';
  projection = 'cinema';
  stereo = 'mono';
  projectionInput.value = projection;
  stereoInput.value = stereo;
  document.querySelector('#now-title').textContent = item.name;
  document.querySelector('#panel-title').textContent = item.name;
  video.src = `/videos/${encodeURIComponent(item.id)}`;
  debugMediaStatus = 'loading';
  video.load();
  video.play().catch(() => {});
  player.classList.remove('hidden');
  document.querySelector('#screen-hint').classList.add('hidden');
  updateProjection();
  updateStereo();
  if (renderer.xr.isPresenting) {
    controlsVisible = false;
    panelMesh.visible = false;
    positionVrPanel();
  }
  drawVrPanel();
}

function closePlayer() {
  if (renderer.xr.isPresenting) renderer.xr.getSession()?.end();
  video.pause();
  video.removeAttribute('src');
  video.load();
  activeVideo = null;
  player.classList.add('hidden');
  document.querySelector('#screen-hint').classList.remove('hidden');
  drawVrPanel();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await player.requestFullscreen();
  } catch (error) {
    playbackNotice = `Fullscreen could not be opened: ${error.message}`;
    document.querySelector('#panel-note').textContent = playbackNotice;
    drawVrPanel();
  }
}

function updateFullscreenButton() {
  const fullscreen = document.fullscreenElement === player;
  const button = document.querySelector('#fullscreen-button');
  button.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
  button.title = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
}

function setDebugEnabled(enabled) {
  debugEnabled = enabled;
  debugFrameCount = 0;
  debugLastUpdate = performance.now();
  debugFps = 0;
  debugVideoFps = 0;
  debugLastVideoFrames = null;
  document.querySelector('#debug-toggle').setAttribute('aria-pressed', String(enabled));
  document.querySelector('#debug-overlay').classList.toggle('hidden', !enabled || xrActive);
  if (enabled) document.querySelector('#debug-overlay').textContent = getDebugOutput();
  drawVrPanel();
}

function recordVrEvent(message) {
  const entry = `${(performance.now() / 1000).toFixed(2)}s ${message}`;
  vrDebugEvents.push(entry);
  if (vrDebugEvents.length > 20) vrDebugEvents.shift();
  if (debugEnabled) console.info('[VR debug]', entry);
  if (debugEnabled && xrActive && panelMesh.visible) drawVrPanel();
}

function getDebugOutput() {
  const inputs = controllers
    .map((controller) => {
      const source = controller.userData.inputSource;
      if (!source) return null;
      const pressed =
        source.gamepad?.buttons
          .map((button, index) => (button.pressed ? index : null))
          .filter((index) => index !== null)
          .join(',') || 'none';
      return `${source.handedness}[${source.profiles.join('/')}] buttons=${pressed}`;
    })
    .filter(Boolean)
    .join(' ');
  let view = 'view yaw=n/a';
  if (xrActive) {
    const direction = renderer.xr.getCamera().getWorldDirection(new THREE.Vector3());
    view = `view yaw=${THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z)).toFixed(1)}°`;
  }
  return [
    getDebugSnapshot(),
    `XR visibility=${xrVisibilityState} | ${view} | ${inputs || 'no input sources'}`,
    ...vrDebugEvents.slice(-8),
  ].join('\n');
}

function getDebugSnapshot() {
  const quality = video.getVideoPlaybackQuality?.();
  const dropped = quality?.droppedVideoFrames ?? video.webkitDroppedFrameCount ?? '—';
  const total = quality?.totalVideoFrames ?? video.webkitDecodedFrameCount ?? '—';
  let buffered = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (start <= video.currentTime && end >= video.currentTime) {
      buffered = Math.max(0, end - video.currentTime);
      break;
    }
  }
  const network =
    debugMediaStatus === 'waiting for data' || debugMediaStatus === 'network stalled'
      ? debugMediaStatus
      : video.paused
        ? 'paused'
        : buffered < 1
          ? 'low buffer'
          : 'buffered';
  const grabState = screenGrab
    ? `grabbing ${screenGrab.handDelta.length().toFixed(2)}m`
    : 'not grabbing';
  return `Render ${debugFps.toFixed(0)} FPS  |  Video ${debugVideoFps.toFixed(0)} FPS  |  Dropped ${dropped}/${total}  |  Buffer ${buffered.toFixed(1)}s  |  ${network}  |  ${grabState}`;
}

function updateDebugMetrics(now) {
  if (!debugEnabled) return;
  debugFrameCount += 1;
  const elapsed = now - debugLastUpdate;
  if (elapsed < 1000) return;
  if (elapsed > 0) debugFps = (debugFrameCount * 1000) / elapsed;
  const videoFrames =
    video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount;
  if (elapsed > 0 && Number.isFinite(videoFrames) && debugLastVideoFrames !== null) {
    debugVideoFps = Math.max(0, ((videoFrames - debugLastVideoFrames) * 1000) / elapsed);
  }
  debugLastVideoFrames = Number.isFinite(videoFrames) ? videoFrames : null;
  debugFrameCount = 0;
  debugLastUpdate = now;
  const snapshot = getDebugSnapshot();
  document.querySelector('#debug-overlay').textContent = getDebugOutput();
  if (xrActive && panelMesh.visible) drawVrPanel();
}

function updateProjection() {
  const spherical = projection === '180' || projection === '360';
  const cinema = projection === 'cinema';
  if (spherical) screenGrab = null;
  renderArea.classList.toggle('drag-look', spherical && !renderer.xr.isPresenting);
  if (!spherical) {
    dragYaw = 0;
    dragPitch = 0;
    camera.rotation.set(0, 0, 0);
  }
  sphere.visible = spherical;
  screen.visible = !spherical;
  if (screen.geometry !== screenGeometry) screen.geometry.dispose();
  screen.geometry = cinema ? createCinemaScreenGeometry() : screenGeometry;
  screen.scale.set(cinema ? 1 : aspect / (16 / 9), 1, 1);
  sphere.geometry.dispose();
  sphere.geometry =
    projection === '180'
      ? new THREE.SphereGeometry(18, 64, 40, Math.PI, Math.PI, 0, Math.PI)
      : new THREE.SphereGeometry(18, 64, 40);
  sphere.geometry.scale(-1, 1, 1);
  sphere.position.set(0, 1.62, 0);
  drawVrPanel();
}

function updateStereo() {
  videoUniforms.uLayout.value = stereo === 'sbs' ? 1 : stereo === 'tb' ? 2 : 0;
  applyVideoMaterial();
  drawVrPanel();
}

function applyVideoMaterial() {
  const material = stereo === 'mono' ? flatVideoMaterial : videoMaterial;
  screen.material = material;
  sphere.material = material;
}

function updatePlaybackUi() {
  document.querySelector('#play-pause').textContent = video.paused ? '▶' : 'Ⅱ';
  document.querySelector('#mute').textContent = video.muted ? '◖̸' : '◖';
  document.querySelector('#elapsed').textContent = formatTime(video.currentTime);
  document.querySelector('#duration').textContent = formatTime(video.duration);
  if (!seeking && Number.isFinite(video.duration) && video.duration > 0)
    seekInput.value = String(Math.round((video.currentTime / video.duration) * 1000));
  if (xrActive && panelMesh.visible) drawVrPanel();
}

function togglePlayback() {
  if (video.paused)
    video.play().catch(() => {
      playbackNotice = 'Playback was blocked. Press play again to start the video.';
      document.querySelector('#panel-note').textContent = playbackNotice;
      drawVrPanel();
    });
  else video.pause();
}

function updateSeekPreview(event) {
  if (!activeVideo || !Number.isFinite(video.duration) || video.duration <= 0) return;
  const bounds = seekInput.getBoundingClientRect();
  const fraction = THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  requestSeekPreview(fraction * video.duration);
  seekPreview.style.left = `${fraction * 100}%`;
  document.querySelector('#seek-preview-time').textContent = formatTime(fraction * video.duration);
  seekPreview.classList.remove('hidden');
}

function requestSeekPreview(time, responsive = false) {
  if (!activeVideo || !Number.isFinite(video.duration)) return;
  seekPreviewTarget = THREE.MathUtils.clamp(time, 0, Math.max(0, video.duration - 0.05));
  const source = `/videos/${encodeURIComponent(activeVideo.id)}`;
  if (seekPreviewSource !== source) {
    seekPreviewSource = source;
    seekPreviewLoading = true;
    seekPreviewHasFrame = false;
    seekPreviewContext.clearRect(0, 0, seekPreviewCanvas.width, seekPreviewCanvas.height);
    seekPreviewVideo.src = source;
    seekPreviewVideo.load();
  } else seekPreviewAtTarget(responsive);
}

function seekPreviewAtTarget(responsive = false) {
  if (!seekPreviewSource || seekPreviewVideo.readyState < HTMLMediaElement.HAVE_METADATA) return;
  const target = THREE.MathUtils.clamp(
    seekPreviewTarget,
    0,
    Math.max(0, seekPreviewVideo.duration - 0.05),
  );
  if (Math.abs(seekPreviewVideo.currentTime - target) < 0.12) return;
  if (seekPreviewLoading && (!responsive || Math.abs(target - seekPreviewRequestedTarget) < 0.08))
    return;
  seekPreviewLoading = true;
  seekPreviewRequestedTarget = target;
  if (responsive && typeof seekPreviewVideo.fastSeek === 'function')
    seekPreviewVideo.fastSeek(target);
  else seekPreviewVideo.currentTime = target;
}

async function checkXR() {
  if (!navigator.xr) {
    xrStatus.textContent =
      'Open this page in a WebXR-compatible browser over trusted HTTPS to use VR.';
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    xrStatus.textContent = supported
      ? 'WebXR detected · controller ready'
      : 'This device does not offer immersive VR.';
  } catch {
    xrStatus.textContent =
      'WebXR is unavailable here. Check trusted HTTPS and browser WebXR support.';
  }
}

async function enterXR() {
  if (!navigator.xr) {
    xrStatus.textContent =
      'WebXR is unavailable. Open this page in a WebXR-compatible browser over trusted HTTPS.';
    return;
  }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor'],
    });
    await renderer.xr.setSession(session);
  } catch (error) {
    xrStatus.textContent =
      error.name === 'SecurityError'
        ? 'VR needs a trusted HTTPS address. Run npm run setup:cert and trust its CA on the headset.'
        : `Could not start VR: ${error.message}`;
  }
}

function onControllerSelect(event) {
  const controller = event.target;
  scene.updateMatrixWorld(true);
  setControllerRay(controller);
  const targets = [
    ...(panelMesh.visible ? [panelMesh] : []),
    ...(activeVideo ? [screen, sphere].filter((object) => object.visible) : []),
  ];
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) {
    if (!activeVideo && !panelMesh.visible) {
      positionVrPanel();
      setVrControlsVisible(true);
    }
    return;
  }
  if (hits[0].object !== panelMesh) {
    setVrControlsVisible(!panelMesh.visible, hits[0].point);
    return;
  }
  const uv = hits[0].uv;
  const x = uv.x * panelCanvas.width;
  const y = (1 - uv.y) * panelCanvas.height;
  const hit = panelHitboxes.find(
    (box) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h,
  );
  if (!hit) {
    setVrControlsVisible(false);
    return;
  }
  handleVrPanelAction(
    hit.action,
    hit.action === 'seek' ? THREE.MathUtils.clamp((x - hit.x) / hit.w, 0, 1) : hit.value,
  );
}

function onScreenGrabStart(event) {
  beginScreenGrab(event.target);
}

function beginScreenGrab(controller) {
  if (!renderer.xr.isPresenting || !activeVideo || !screen.visible || screenGrab) return;
  scene.updateMatrixWorld(true);
  renderer.xr.getCamera().getWorldPosition(grabViewPosition);
  const startScreenOffset = screen.position.clone().sub(grabViewPosition);
  const moveForward = new THREE.Vector3(startScreenOffset.x, 0, startScreenOffset.z);
  if (moveForward.lengthSq() === 0) moveForward.set(0, 0, -1);
  moveForward.normalize();
  screenGrab = {
    controller,
    startControllerPosition: controller.getWorldPosition(new THREE.Vector3()),
    previousControllerPosition: controller.getWorldPosition(new THREE.Vector3()),
    startViewerPosition: grabViewPosition.clone(),
    startScreenOffset,
    currentScreenOffset: new THREE.Vector3(),
    horizontalRadius: Math.hypot(startScreenOffset.x, startScreenOffset.z),
    horizontalTravel: 0,
    verticalTravel: 0,
    startScreenRotation: screen.quaternion.clone(),
    moveRight: new THREE.Vector3(-moveForward.z, 0, moveForward.x),
    moveUp: new THREE.Vector3(0, 1, 0),
    depthDirection: new THREE.Vector3(),
    currentControllerPosition: new THREE.Vector3(),
    controllerDelta: new THREE.Vector3(),
    handDelta: new THREE.Vector3(),
    depthOffset: 0,
    depthVelocity: 0,
    lastFrameTime: performance.now(),
  };
  // Drag along a tangent around the viewer so lateral movement does not alter
  // the screen's distance. Hand movement toward or away from the viewer is ignored.
  recordVrEvent(`screen grab start ${controller.userData.inputSource?.handedness || 'unknown'}`);
}

function onScreenGrabEnd(event) {
  if (screenGrab?.controller === event.target) {
    recordVrEvent(
      `screen grab end ${screenGrab.controller.userData.inputSource?.handedness || 'unknown'}`,
    );
    screenGrab = null;
  }
}

function updateScreenGrab(now) {
  if (!screenGrab) return;
  const grab = screenGrab;
  grab.controller.getWorldPosition(grab.currentControllerPosition);
  const inputSource = grab.controller.userData.inputSource;
  const axes = inputSource?.gamepad?.axes;
  const thumbstickY = axes?.length >= 4 ? axes[3] : axes?.[1];
  const elapsed = Math.min(Math.max((now - grab.lastFrameTime) / 1000, 0), 0.05);
  const stick =
    Number.isFinite(thumbstickY) && Math.abs(thumbstickY) > 0.18
      ? (-Math.sign(thumbstickY) * (Math.abs(thumbstickY) - 0.18)) / 0.82
      : 0;
  if (stick) grab.depthVelocity += stick * 12 * elapsed;
  else grab.depthVelocity *= Math.exp(-6 * elapsed);
  grab.depthVelocity = THREE.MathUtils.clamp(grab.depthVelocity, -8, 8);
  grab.depthOffset = THREE.MathUtils.clamp(
    grab.depthOffset + grab.depthVelocity * elapsed,
    MIN_SCREEN_DISTANCE - grab.horizontalRadius,
    MAX_SCREEN_DISTANCE - grab.horizontalRadius,
  );
  if (
    grab.depthOffset <= MIN_SCREEN_DISTANCE - grab.horizontalRadius ||
    grab.depthOffset >= MAX_SCREEN_DISTANCE - grab.horizontalRadius
  ) {
    grab.depthVelocity = 0;
  }
  grab.lastFrameTime = now;
  grab.controllerDelta.subVectors(grab.currentControllerPosition, grab.previousControllerPosition);
  grab.previousControllerPosition.copy(grab.currentControllerPosition);
  grab.horizontalTravel += grab.controllerDelta.dot(grab.moveRight) * 20;
  grab.verticalTravel += grab.controllerDelta.dot(grab.moveUp) * 20;
  grab.handDelta.subVectors(grab.currentControllerPosition, grab.startControllerPosition);
  const yawOffset = -grab.horizontalTravel / Math.max(grab.horizontalRadius, 0.1);
  grab.currentScreenOffset.copy(grab.startScreenOffset).applyAxisAngle(grab.moveUp, yawOffset);
  grab.depthDirection.set(grab.currentScreenOffset.x, 0, grab.currentScreenOffset.z).normalize();
  screen.position
    .copy(grab.startViewerPosition)
    .add(grab.currentScreenOffset)
    .addScaledVector(grab.depthDirection, grab.depthOffset)
    .addScaledVector(grab.moveUp, grab.verticalTravel);
  if (projection === 'cinema') {
    renderer.xr.getCamera().getWorldPosition(grabViewPosition);
    const yaw = Math.atan2(
      grabViewPosition.x - screen.position.x,
      grabViewPosition.z - screen.position.z,
    );
    screen.quaternion.setFromAxisAngle(grabViewUp, yaw);
  } else {
    screen.quaternion.copy(grab.startScreenRotation);
  }
}

function updateControllerButtons() {
  for (const controller of controllers) {
    const inputSource = controller.userData.inputSource;
    const gamepad = inputSource?.gamepad;
    const pressedButtons =
      gamepad?.buttons
        .map((button, index) => (button.pressed ? index : null))
        .filter((index) => index !== null) || [];
    const buttonSignature = pressedButtons.join(',') || 'none';
    if (controller.userData.debugButtonSignature !== buttonSignature) {
      if (controller.userData.debugButtonSignature !== undefined || pressedButtons.length) {
        recordVrEvent(`${inputSource?.handedness || 'unknown'} buttons ${buttonSignature}`);
      }
      controller.userData.debugButtonSignature = buttonSignature;
    }
    // The right-hand secondary face button is B on the supported controller
    // profile. It is exposed as button 5 after WebXR's four standard inputs.
    const bPressed =
      inputSource?.handedness === 'right' &&
      gamepad?.mapping === 'xr-standard' &&
      gamepad.buttons.length > 5 &&
      gamepad.buttons[5].pressed;
    if (bPressed && !controller.userData.bPressed) {
      renderer.xr.getSession()?.end();
    }
    controller.userData.bPressed = Boolean(bPressed);
  }
}

function handleVrPanelAction(action, value) {
  if (action === 'exit') renderer.xr.getSession()?.end();
  else if (action === 'hide-collection') {
    collectionVisible = false;
    setVrControlsVisible(Boolean(activeVideo));
  } else if (action === 'toggle-controls') {
    setVrControlsVisible(!panelMesh.visible);
  } else if (action === 'catalogue-prev') cataloguePage = Math.max(0, cataloguePage - 1);
  else if (action === 'catalogue-next')
    cataloguePage = Math.min(Math.max(0, Math.ceil(videos.length / 6) - 1), cataloguePage + 1);
  else if (action === 'select') {
    const item = videos.find((entry) => entry.id === value);
    if (item) playVideo(item);
  } else if (action === 'play') togglePlayback();
  else if (action === 'projection') {
    projection = value;
    projectionInput.value = value;
    updateProjection();
  } else if (action === 'stereo') {
    stereo = value;
    stereoInput.value = value;
    updateStereo();
  } else if (action === 'seek' && Number.isFinite(video.duration))
    video.currentTime = video.duration * value;
  else if (action === 'mute') {
    video.muted = !video.muted;
    updatePlaybackUi();
  } else if (action === 'debug') setDebugEnabled(!debugEnabled);
  else if (action === 'center') {
    screenGrab = null;
    recordVrEvent('player center');
    anchorSceneToViewer();
  } else if (action === 'library') {
    collectionVisible = true;
    if (renderer.xr.isPresenting) {
      controlsVisible = true;
      panelMesh.visible = true;
      positionVrPanel();
    }
  } else if (action === 'previous' || action === 'next') {
    const index = videos.findIndex((item) => item.id === activeVideo?.id);
    const next = videos[(index + (action === 'next' ? 1 : -1) + videos.length) % videos.length];
    if (next) playVideo(next);
  }
  drawVrPanel();
}

function drawVrPanel() {
  const ctx = panelContext;
  const width = panelCanvas.width;
  const height = panelCanvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(12,13,20,0.91)';
  roundedRect(ctx, 4, 4, width - 8, height - 8, 32);
  ctx.fill();
  panelHitboxes = [];
  const showingCollection = !activeVideo || collectionVisible;
  ctx.fillStyle = '#a895f4';
  ctx.font = '500 22px Arial, sans-serif';
  ctx.fillText(showingCollection ? 'YOUR COLLECTION' : 'NOW PLAYING', 40, 48);
  ctx.fillStyle = '#f2effa';
  ctx.font = '600 27px Arial, sans-serif';
  fitText(
    ctx,
    showingCollection ? 'Choose a video' : activeVideo.name,
    showingCollection ? 40 : 218,
    showingCollection ? 91 : 49,
    showingCollection ? width - 80 : width - 430,
  );
  drawButton(ctx, width - 176, 22, 136, 44, 'Exit VR', 'exit');

  if (showingCollection) {
    drawButton(ctx, width - 350, 22, 150, 44, 'Hide List', 'hide-collection');
    const pageCount = Math.max(1, Math.ceil(videos.length / 6));
    const visible = videos.slice(cataloguePage * 6, (cataloguePage + 1) * 6);
    visible.forEach((item, index) => {
      const rowY = 105 + index * 56;
      ctx.fillStyle = index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.065)';
      roundedRect(ctx, 35, rowY, width - 70, 48, 10);
      ctx.fill();
      const thumbnail = thumbnailCache.get(item.id);
      if (thumbnail) ctx.drawImage(thumbnail, 49, rowY + 5, 68, 38);
      else if (!thumbnailRequests.has(item.id)) {
        getVideoThumbnail(item)
          .then(() => drawVrPanel())
          .catch(() => {});
      }
      ctx.fillStyle = '#e8e5ef';
      ctx.font = '500 23px Arial, sans-serif';
      fitText(ctx, item.name, 132, rowY + 31, width - 265);
      ctx.fillStyle = '#908b9c';
      ctx.font = '18px Arial, sans-serif';
      ctx.fillText(formatSize(item.size), width - 126, rowY + 30);
      addHitbox(35, rowY, width - 70, 48, 'select', item.id);
    });
    if (!visible.length) {
      ctx.fillStyle = '#aaa6b3';
      ctx.font = '22px Arial, sans-serif';
      ctx.fillText('Add MP4 files to the videos folder.', 40, 160);
    }
    drawButton(ctx, 35, 460, 145, 44, '←  Previous', 'catalogue-prev');
    ctx.fillStyle = '#aaa6b3';
    ctx.font = '18px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${cataloguePage + 1} / ${pageCount}`, width / 2, 488);
    ctx.textAlign = 'left';
    drawButton(ctx, width - 180, 460, 145, 44, 'Next  →', 'catalogue-next');
  } else {
    const playY = 82;
    drawButton(ctx, 40, playY, 140, 50, video.paused ? '▶  Play' : 'Ⅱ  Pause', 'play');
    drawButton(ctx, 195, playY, 82, 50, '◀', 'previous');
    drawButton(ctx, 290, playY, 82, 50, '▶▶', 'next');
    drawButton(ctx, 385, playY, 130, 50, 'Library', 'library');
    drawButton(ctx, 535, playY, 130, 50, debugEnabled ? 'Stats on' : 'Stats off', 'debug');
    drawButton(ctx, 680, playY, 130, 50, 'Center', 'center');
    drawButton(ctx, width - 160, playY, 120, 50, video.muted ? 'Muted' : 'Sound', 'mute');

    const timeY = 175;
    ctx.fillStyle = '#aaa6b3';
    ctx.font = '18px Arial, sans-serif';
    ctx.fillStyle = '#373442';
    roundedRect(ctx, 40, timeY, width - 80, 13, 7);
    ctx.fill();
    const progress =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.currentTime / video.duration
        : 0;
    ctx.fillStyle = '#a895f4';
    roundedRect(ctx, 40, timeY, Math.max(14, (width - 80) * progress), 13, 7);
    ctx.fill();
    ctx.fillStyle = '#aaa6b3';
    ctx.font = '18px Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(video.currentTime), 40, timeY + 36);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(video.duration), width - 40, timeY + 36);
    ctx.textAlign = 'left';
    addHitbox(40, timeY - 32, width - 80, 77, 'seek');
    if (vrSeekPreviewVisible) {
      const previewWidth = 180;
      const previewHeight = 102;
      const timelineX = 40 + vrSeekPreviewFraction * (width - 80);
      const previewX = THREE.MathUtils.clamp(
        timelineX - previewWidth / 2,
        8,
        width - previewWidth - 8,
      );
      const previewY = timeY - previewHeight - 8;
      ctx.fillStyle = 'rgba(8,9,13,.96)';
      roundedRect(ctx, previewX - 3, previewY - 3, previewWidth + 6, previewHeight + 6, 7);
      ctx.fill();
      if (seekPreviewHasFrame)
        ctx.drawImage(seekPreviewCanvas, previewX, previewY, previewWidth, previewHeight);
      else {
        ctx.fillStyle = '#171923';
        roundedRect(ctx, previewX, previewY, previewWidth, previewHeight, 4);
        ctx.fill();
      }
      if (seekPreviewLoading || !seekPreviewHasFrame) {
        const pulse = 0.38 + (Math.sin(performance.now() / 170) + 1) * 0.22;
        ctx.fillStyle = `rgba(8,9,13,${pulse})`;
        roundedRect(ctx, previewX, previewY, previewWidth, previewHeight, 4);
        ctx.fill();
        ctx.strokeStyle = '#c4b5ff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(previewX + previewWidth / 2, previewY + 38, 11, -Math.PI / 2, Math.PI * 1.15);
        ctx.stroke();
        ctx.fillStyle = '#f3efff';
        ctx.font = '14px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading preview', previewX + previewWidth / 2, previewY + 73);
        ctx.textAlign = 'left';
      }
      ctx.fillStyle = 'rgba(8,9,13,.78)';
      ctx.fillRect(previewX, previewY + previewHeight - 20, previewWidth, 20);
      ctx.fillStyle = '#f3efff';
      ctx.font = '14px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        formatTime(seekPreviewTarget),
        previewX + previewWidth / 2,
        previewY + previewHeight - 4,
      );
      ctx.textAlign = 'left';
    }

    ctx.fillStyle = '#a895f4';
    ctx.font = '500 20px Arial, sans-serif';
    ctx.fillText('PROJECTION', 40, 248);
    drawOption(ctx, 40, 260, 145, 45, 'Flat · 2D', 'projection', 'flat', projection === 'flat');
    drawOption(ctx, 195, 260, 145, 45, 'Cinema', 'projection', 'cinema', projection === 'cinema');
    drawOption(ctx, 350, 260, 145, 45, '180°', 'projection', '180', projection === '180');
    drawOption(ctx, 505, 260, 145, 45, '360°', 'projection', '360', projection === '360');

    ctx.fillStyle = '#a895f4';
    ctx.font = '500 20px Arial, sans-serif';
    ctx.fillText('STEREO LAYOUT', 40, 350);
    drawOption(ctx, 40, 362, 195, 45, 'Mono', 'stereo', 'mono', stereo === 'mono');
    drawOption(ctx, 255, 362, 195, 45, 'Side by side', 'stereo', 'sbs', stereo === 'sbs');
    drawOption(ctx, 470, 362, 195, 45, 'Top / bottom', 'stereo', 'tb', stereo === 'tb');
    if (playbackNotice) {
      ctx.fillStyle = '#e5b18f';
      ctx.font = '17px Arial, sans-serif';
      fitText(ctx, playbackNotice, 40, 510, width - 80);
    }
    if (debugEnabled) {
      const debugLines = getDebugOutput().split('\n');
      ctx.fillStyle = '#c9c2dd';
      ctx.font = '13px monospace';
      fitText(ctx, debugLines[0] || '', 40, 430, width - 80);
      fitText(ctx, debugLines[1] || '', 40, 450, width - 80);
      const recentEvents = vrDebugEvents.slice(-3);
      for (let index = 0; index < 3; index += 1) {
        fitText(ctx, recentEvents[index] || '', 40, 474 + index * 17, width - 80);
      }
    }
  }
  panelTexture.needsUpdate = true;
}

function addHitbox(x, y, w, h, action, value) {
  panelHitboxes.push({ x, y, w, h, action, value });
}
function drawButton(ctx, x, y, w, h, label, action) {
  ctx.fillStyle = 'rgba(169,148,255,.16)';
  roundedRect(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(190,174,255,.42)';
  ctx.lineWidth = 2;
  roundedRect(ctx, x, y, w, h, 14);
  ctx.stroke();
  ctx.fillStyle = '#f3efff';
  ctx.font = '600 22px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + 8);
  ctx.textAlign = 'left';
  addHitbox(x, y, w, h, action);
}
function drawOption(ctx, x, y, w, h, label, action, value, selected) {
  ctx.fillStyle = selected ? 'rgba(169,148,255,.32)' : 'rgba(255,255,255,.055)';
  roundedRect(ctx, x, y, w, h, 11);
  ctx.fill();
  ctx.strokeStyle = selected ? '#a895f4' : 'rgba(255,255,255,.13)';
  ctx.lineWidth = 2;
  roundedRect(ctx, x, y, w, h, 11);
  ctx.stroke();
  ctx.fillStyle = '#efecf6';
  ctx.font = '500 20px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + 7);
  ctx.textAlign = 'left';
  addHitbox(x, y, w, h, action, value);
}
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function fitText(ctx, text, x, y, max) {
  let shown = text;
  while (ctx.measureText(shown).width > max && shown.length > 3) shown = `${shown.slice(0, -4)}…`;
  ctx.fillText(shown, x, y);
}

function onXRReferenceSpaceReset() {
  recordVrEvent('reference space reset');
  screenGrab = null;
  xrAnchored = false;
}

function onXRSessionVisibilityChange() {
  xrVisibilityState = xrSession?.visibilityState || 'unknown';
  recordVrEvent(`visibility ${xrVisibilityState}`);
  if (xrSession?.visibilityState !== 'visible') return;
  onXRReferenceSpaceReset();
  if (debugEnabled) setVrControlsVisible(true);
}

function render() {
  const now = performance.now();
  updateDebugMetrics(now);
  if (renderer.xr.isPresenting) {
    if (!xrAnchored) anchorSceneToViewer();
    updateControllerButtons();
    updateScreenGrab(now);
    updateControllerRays();
  }
  renderer.render(scene, camera);
}

function anchorSceneToViewer() {
  // In immersive mode the XR cameras are updated from the headset pose before
  // this animation callback. The base camera still contains the desktop pose.
  const viewer = renderer.xr.getCamera();
  viewer.updateMatrixWorld(true);
  const position = viewer.getWorldPosition(new THREE.Vector3());
  const forward = viewer.getWorldDirection(new THREE.Vector3());
  forward.y = 0;
  forward.normalize();
  if (forward.lengthSq() === 0) forward.set(0, 0, -1);
  const yaw = Math.atan2(-forward.x, -forward.z);
  const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const screenDistance = projection === 'cinema' ? 6 : 3.1;
  screen.position.copy(position).addScaledVector(forward, screenDistance);
  screen.position.y -= 0.08;
  screen.quaternion.copy(facing);
  sphere.position.copy(position);
  sphere.rotation.set(0, yaw, 0);
  positionVrPanel(position, forward, facing);
  xrAnchored = true;
}

function positionVrPanel(position, forward, facing) {
  const viewer = renderer.xr.getCamera();
  viewer.updateMatrixWorld(true);
  position ||= viewer.getWorldPosition(new THREE.Vector3());
  forward ||= viewer.getWorldDirection(new THREE.Vector3());
  forward.y = 0;
  forward.normalize();
  if (forward.lengthSq() === 0) forward.set(0, 0, -1);
  if (!facing) {
    const yaw = Math.atan2(-forward.x, -forward.z);
    facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  }
  panelMesh.position.copy(position).addScaledVector(forward, 1.55);
  // Center the compact playback panel over the screen.
  panelMesh.position.y += activeVideo ? -0.08 : -0.12;
  panelMesh.quaternion.copy(facing);
  panelMesh.updateMatrixWorld(true);
}

function updateControllerRays() {
  if (!panelMesh.visible) {
    pointerDot.visible = false;
    return;
  }
  let found = false;
  let hoveredSeekFraction = null;
  for (const controller of controllers) {
    setControllerRay(controller);
    const targets = [
      ...(panelMesh.visible ? [panelMesh] : []),
      ...(activeVideo ? [screen, sphere].filter((object) => object.visible) : []),
    ];
    const hit = raycaster.intersectObjects(targets, false)[0];
    controller.children[0].scale.z = hit ? hit.distance : 2;
    if (hit) {
      pointerDot.position.copy(hit.point);
      pointerDot.visible = true;
      found = true;
      if (hit.object === panelMesh && activeVideo) {
        const x = hit.uv.x * panelCanvas.width;
        const y = (1 - hit.uv.y) * panelCanvas.height;
        const seekHitbox = panelHitboxes.find(
          (box) => box.action === 'seek' && x >= box.x && x <= box.x + box.w,
        );
        if (seekHitbox && y >= seekHitbox.y && y <= seekHitbox.y + seekHitbox.h) {
          hoveredSeekFraction = THREE.MathUtils.clamp((x - seekHitbox.x) / seekHitbox.w, 0, 1);
        }
      }
    }
  }
  if (!found) pointerDot.visible = false;
  if (hoveredSeekFraction === null) {
    if (vrSeekPreviewVisible) {
      vrSeekPreviewVisible = false;
      drawVrPanel();
    }
  } else {
    const changed =
      !vrSeekPreviewVisible || Math.abs(vrSeekPreviewFraction - hoveredSeekFraction) > 0.002;
    vrSeekPreviewVisible = true;
    if (changed) {
      vrSeekPreviewFraction = hoveredSeekFraction;
      drawVrPanel();
    }
    const previewTime = hoveredSeekFraction * video.duration;
    if (Math.abs(previewTime - seekPreviewTarget) > 0.06) requestSeekPreview(previewTime, true);
  }
  if (vrSeekPreviewVisible && (seekPreviewLoading || !seekPreviewHasFrame)) {
    const animationStep = Math.floor(performance.now() / 220);
    if (animationStep !== vrPreviewAnimationStep) {
      vrPreviewAnimationStep = animationStep;
      drawVrPanel();
    }
  }
}

function setVrControlsVisible(visible, videoPoint) {
  if (visible && activeVideo) collectionVisible = false;
  controlsVisible = visible;
  panelMesh.visible = visible;
  if (visible) {
    if (videoPoint) positionVrPanelAt(videoPoint);
    drawVrPanel();
  }
}

function getVideoThumbnail(item) {
  if (thumbnailCache.has(item.id)) return Promise.resolve(thumbnailCache.get(item.id));
  if (thumbnailRequests.has(item.id)) return thumbnailRequests.get(item.id);
  const request = new Promise((resolve, reject) => {
    const thumbnailVideo = document.createElement('video');
    thumbnailVideo.muted = true;
    thumbnailVideo.preload = 'metadata';
    thumbnailVideo.playsInline = true;
    const canvas = document.createElement('canvas');
    const finish = (error) => {
      thumbnailVideo.removeAttribute('src');
      thumbnailVideo.load();
      if (error) reject(error);
    };
    const capture = () => {
      if (thumbnailVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const ratio = thumbnailVideo.videoWidth / thumbnailVideo.videoHeight || 16 / 9;
      canvas.width = Math.min(480, Math.round(270 * ratio));
      canvas.height = Math.max(1, Math.round(canvas.width / ratio));
      try {
        canvas.getContext('2d').drawImage(thumbnailVideo, 0, 0, canvas.width, canvas.height);
        finish();
        const image = new Image();
        image.onload = () => {
          thumbnailCache.set(item.id, image);
          resolve(image);
        };
        image.onerror = () => reject(new Error('Video thumbnail could not be encoded.'));
        image.src = canvas.toDataURL('image/jpeg', 0.76);
      } catch (error) {
        finish(error);
      }
    };
    thumbnailVideo.addEventListener(
      'loadeddata',
      () => {
        if (thumbnailVideo.duration > 0.5) {
          thumbnailVideo.currentTime = thumbnailVideo.duration / 2;
        } else capture();
      },
      { once: true },
    );
    thumbnailVideo.addEventListener('seeked', capture, { once: true });
    thumbnailVideo.addEventListener(
      'error',
      () => finish(new Error('Video thumbnail could not be decoded.')),
      { once: true },
    );
    thumbnailVideo.src = `/videos/${encodeURIComponent(item.id)}`;
    thumbnailVideo.load();
  }).finally(() => thumbnailRequests.delete(item.id));
  thumbnailRequests.set(item.id, request);
  return request;
}

function positionVrPanelAt(videoPoint) {
  const viewer = renderer.xr.getCamera();
  viewer.updateMatrixWorld(true);
  const viewerPosition = viewer.getWorldPosition(new THREE.Vector3());
  const clickDirection = videoPoint.clone().sub(viewerPosition).normalize();
  panelMesh.position.copy(viewerPosition).addScaledVector(clickDirection, 1.5);
  panelMesh.position.y -= 0.3;
  panelMesh.lookAt(viewerPosition);
  panelMesh.updateMatrixWorld(true);
}

function getCanvasVideoHit(event) {
  const bounds = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
  );
  scene.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(
    [screen, sphere].filter((object) => object.visible),
    false,
  )[0];
}

function setControllerRay(controller) {
  const rotation = new THREE.Matrix4().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation).normalize();
}

function resize() {
  const width = renderArea.clientWidth || window.innerWidth;
  const height = renderArea.clientHeight || window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function setPanelVisible(visible) {
  panel.classList.toggle('xr-hidden', !visible);
  document.querySelector('#panel-show').classList.toggle('hidden', visible);
  panelMesh.visible = visible && xrActive;
}
function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function formatSize(value) {
  if (!Number.isFinite(value)) return '';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(value / 1024 ** 2))} MB`;
}
function showMessage(text) {
  message.textContent = text;
  message.classList.remove('hidden');
}
