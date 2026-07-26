/* ============================================================
   SOS · LOADNUG — Premium WebGL cinematic (Three.js)
   Deep 3D city + commercial brand cards:
   P2P · TORRENT · BLOSSOM · RELAY
   ============================================================ */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const smoothstep = (a, b, t) => {
  const x = clamp((t - a) / (b - a || 1e-6), 0, 1);
  return x * x * (3 - 2 * x);
};

const COL = {
  bg: 0x070b19,
  blue: 0x2d88ff,
  sky: 0x4fc3f7,
  cyan: 0x63e6be,
  aqua: 0x00ffcc,
  violet: 0x667eea,
  magenta: 0xf093fb,
  orange: 0xff6d00,
  torrent: 0x2ecc71,
  blossom: 0xff6b9d,
  relay: 0x7c5cff,
};

export class LoadNugScene {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.quality = opts.quality || 1;
    this.duration = opts.duration || 90;
    this._raf = 0;
    this._running = false;
    this._disposed = false;
    this._holdSignaled = false;
    this._tStart = 0;
    this._onProgress = opts.onProgress || (() => {});
    this._onPhase = opts.onPhase || (() => {});
    this._resolve = null;
    this._tmp = {
      m: new THREE.Matrix4(),
      p: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      s: new THREE.Vector3(1, 1, 1),
    };
    this._initRenderer();
    // Scale content density for weak devices after renderer knows mobile flag
    if (this._low) this.quality = Math.min(this.quality, 0.62);
    else if (this._mobile) this.quality = Math.min(this.quality, 0.85);
    this._initScene();
    this._initCity();
    this._initStreets();
    this._initStreetProps();
    this._initCars();
    this._initConnections();
    this._initPackets();
    this._initParticles();
    if (!this._low) {
      this._initBrandCards();
      this._initVoiceWave();
      this._initVideoCall();
      this._initRelays();
      this._initBlossomNodes();
      this._initLogo();
    } else {
      this._brands = [];
      this._voiceMat = { opacity: 0 };
      this._callMat = { opacity: 0 };
      this._callEMat = { opacity: 0 };
      this._blossomMat = { opacity: 0 };
      this._blossomPos = [];
      this._relayMat = { opacity: 0 };
      this._logoMat = { opacity: 0 };
      this._logoGlowMat = { opacity: 0 };
      this._logo = null;
    }
    this._initCameraPath();
    this._resize();
  }

  _detectLowPower() {
    try {
      const cores = navigator.hardwareConcurrency || 8;
      const mem = navigator.deviceMemory || 8;
      const save = !!(navigator.connection && navigator.connection.saveData);
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const tiny = matchMedia('(max-width: 420px)').matches;
      return save || reduced || cores <= 4 || mem <= 4 || (this._mobile && (cores <= 6 || mem <= 6 || tiny));
    } catch (e) {
      return !!this._mobile;
    }
  }

  _viewport() {
    const vv = window.visualViewport;
    const w = Math.max(1, Math.round((vv && vv.width) || window.innerWidth || 1));
    const h = Math.max(1, Math.round((vv && vv.height) || window.innerHeight || 1));
    return { w, h };
  }

  _initRenderer() {
    const mobile = !!this.opts.mobile || matchMedia('(max-width: 820px), (pointer: coarse)').matches;
    this._mobile = mobile;
    this._low = this._detectLowPower();
    const dprCap = this._low ? 1.15 : mobile ? 1.35 : 1.75;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !this._low && !mobile,
      alpha: false,
      powerPreference: this._low ? 'low-power' : 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    const { w, h } = this._viewport();
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(COL.bg, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this._low ? 1.15 : 1.35;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = false;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    // Soft depth fog — keep city readable, not a black void
    this.scene.fog = new THREE.FogExp2(0x0a1228, 0.0032);
    this.scene.background = new THREE.Color(0x0a1228);
    const { w, h } = this._viewport();
    this.camera = new THREE.PerspectiveCamera(58, w / h, 0.1, 3000);

    this.scene.add(new THREE.AmbientLight(0x2a3a5c, this._low ? 0.85 : 0.7));
    const key = new THREE.DirectionalLight(0xa8c8ff, this._low ? 0.7 : 0.95);
    key.position.set(70, 140, 50);
    this.scene.add(key);
    if (!this._low) {
      const rim = new THREE.DirectionalLight(0x667eea, 0.55);
      rim.position.set(-90, 50, -70);
      this.scene.add(rim);
    }
    const fill = new THREE.PointLight(0x00ffcc, this._low ? 0.3 : 0.45, this._low ? 280 : 500);
    fill.position.set(0, 40, 30);
    this.scene.add(fill);

    // Night sky + arcade starfield
    const skyGeo = new THREE.SphereGeometry(900, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vP;
        void main(){
          float h = normalize(vP).y;
          vec3 top = vec3(0.02, 0.04, 0.12);
          vec3 mid = vec3(0.04, 0.07, 0.18);
          vec3 hor = vec3(0.06, 0.10, 0.22);
          vec3 col = mix(hor, mid, smoothstep(-0.05, 0.25, h));
          col = mix(col, top, smoothstep(0.25, 0.85, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));
    this._initStars();

    const gmat = new THREE.MeshStandardMaterial({
      color: 0x080c16,
      roughness: 0.95,
      metalness: 0.08,
      emissive: 0x0c1830,
      emissiveIntensity: 0.35,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), gmat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.04;
    this.scene.add(ground);
    this._groundMat = gmat;
  }

  _initStars() {
    const n = this._low ? 220 : this._mobile ? 450 : 1100;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(0.08 + v * 0.92);
      const r = 420 + Math.random() * 380;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 40;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const bright = 0.55 + Math.random() * 0.45;
      const tint = Math.random();
      col[i * 3] = bright * (tint > 0.7 ? 0.7 : 0.85);
      col[i * 3 + 1] = bright * (tint > 0.85 ? 0.85 : 0.95);
      col[i * 3 + 2] = bright;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: this._low ? 1.6 : this._mobile ? 1.5 : 1.8,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });
    this._stars = new THREE.Points(geo, mat);
    this.scene.add(this._stars);
  }

  _resize() {
    if (!this.renderer || !this.camera) return;
    const { w, h } = this._viewport();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _onResize = () => this._resize();

  _initCity() {
    const q = this.quality;
    const cols = Math.round(clamp(15 * q, this._low ? 9 : 11, this._low ? 13 : 17));
    const rows = Math.round(clamp(15 * q, this._low ? 9 : 11, this._low ? 13 : 17));
    const spacing = this._low ? 8.6 : 8.2;
    const streetEvery = this._low ? 6 : 5;
    this._citySpacing = spacing;
    this._cityCols = cols;
    this._cityRows = rows;
    this._streetEvery = streetEvery;
    this._streetAxes = { ns: [], ew: [] };

    this._nodes = [];
    this._billboardAnchors = [];
    this._cityGroup = new THREE.Group();
    this.scene.add(this._cityGroup);

    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x0a101c,
      metalness: 0.7,
      roughness: 0.28,
      emissive: 0x1a4060,
      emissiveIntensity: 0.18,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x152238,
      metalness: 0.85,
      roughness: 0.18,
      emissive: 0x2d88ff,
      emissiveIntensity: 0.12,
    });

    // Reuse a small pool of facade materials (avoids hundreds of canvas textures)
    const facadePool = [
      this._makeFacadeMaterial(0x152238, COL.blue, 8),
      this._makeFacadeMaterial(0x1a2040, COL.violet, 10),
      this._makeFacadeMaterial(0x101c30, COL.sky, 7),
      this._makeFacadeMaterial(0x182848, COL.aqua, 9),
    ];

    for (let ix = 0; ix < cols; ix++) {
      for (let iz = 0; iz < rows; iz++) {
        const onStreet = (ix % streetEvery === 0) || (iz % streetEvery === 0);
        if (onStreet) continue;

        const gx = (ix - cols / 2) * spacing + (Math.random() - 0.5) * 0.25;
        const gz = (iz - rows / 2) * spacing + (Math.random() - 0.5) * 0.25;
        const style = (Math.random() * 3) | 0;
        const floors = style === 0 ? 10 + ((Math.random() * 12) | 0)
          : style === 1 ? 6 + ((Math.random() * 7) | 0)
          : 4 + ((Math.random() * 4) | 0);
        const floorH = 1.65;
        const h = floors * floorH;
        const w = style === 2 ? 4.0 + Math.random() * 2.2 : 3.2 + Math.random() * 2.4;
        const d = style === 2 ? 3.6 + Math.random() * 1.8 : 3.2 + Math.random() * 2.4;
        const glow = [COL.blue, COL.violet, COL.sky, COL.aqua][(Math.random() * 4) | 0];
        const facade = facadePool[(Math.random() * facadePool.length) | 0];

        const building = new THREE.Group();
        building.position.set(gx, 0, gz);

        const podiumH = 1.35;
        const podium = new THREE.Mesh(
          new THREE.BoxGeometry(w * 1.1, podiumH, d * 1.1),
          trimMat
        );
        podium.position.y = podiumH / 2;
        building.add(podium);

        const store = new THREE.Mesh(
          new THREE.BoxGeometry(w * 1.0, podiumH * 0.7, d * 1.0),
          glassMat
        );
        store.position.y = podiumH * 0.55;
        building.add(store);

        const shaftH = h - podiumH * 0.2;
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, shaftH, d), facade);
        body.position.y = podiumH + shaftH / 2;
        building.add(body);

        if (!this._low) {
          const pierW = 0.2;
          const pierGeo = new THREE.BoxGeometry(pierW, shaftH + 0.15, pierW);
          for (const [cx, cz] of [[w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) {
            const pier = new THREE.Mesh(pierGeo, trimMat);
            pier.position.set(cx, podiumH + shaftH / 2, cz);
            building.add(pier);
          }
        }

        let topH = podiumH + shaftH;
        if (!this._low && (style === 0 || h > 14)) {
          const cw = w * 0.68;
          const cd = d * 0.68;
          const ch = 2.2 + Math.random() * 3.5;
          const crown = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, cd), facade);
          crown.position.y = topH + ch / 2;
          building.add(crown);
          topH += ch;
          const roof = new THREE.Mesh(new THREE.BoxGeometry(cw * 1.1, 0.35, cd * 1.1), trimMat);
          roof.position.y = topH + 0.18;
          building.add(roof);
          topH += 0.35;
        } else {
          const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.05, 0.3, d * 1.05), trimMat);
          roof.position.y = topH + 0.15;
          building.add(roof);
          topH += 0.3;
        }

        this._cityGroup.add(building);
        this._nodes.push({ x: gx, y: topH, z: gz, w, d, col: new THREE.Color(glow) });

        // Prefer anchors facing the main avenues (for billboards along drive)
        const nearNS = Math.min(ix % streetEvery, streetEvery - (ix % streetEvery)) === 1;
        const nearEW = Math.min(iz % streetEvery, streetEvery - (iz % streetEvery)) === 1;
        if (nearNS || nearEW) {
          this._billboardAnchors.push({
            x: gx, y: Math.min(podiumH + shaftH * 0.42, 11),
            z: gz, w, d, h: topH,
            faceX: nearNS, faceZ: nearEW,
          });
        }
      }
    }

    // Record street centerlines
    for (let ix = 0; ix < cols; ix += streetEvery) {
      this._streetAxes.ns.push((ix - cols / 2) * spacing);
    }
    for (let iz = 0; iz < rows; iz += streetEvery) {
      this._streetAxes.ew.push((iz - rows / 2) * spacing);
    }

    this._cityMesh = null;
    this._cityAct = null;
    this._cityCount = this._nodes.length;
    this._cityUniforms = { uTime: { value: 0 }, uReveal: { value: 1 } };

    this._initStreetBillboards();
    this._sealAvenueEnds();
  }

  /** Close the avenue ends with buildings so the camera never stares into void */
  _sealAvenueEnds() {
    const ns = this._streetAxes.ns || [];
    const ax = ns[Math.min(1, ns.length - 1)] || 0;
    const sp = this._citySpacing;
    const rows = this._cityRows;
    const zFar = (rows / 2) * sp + sp * 0.35;
    const zNear = (-rows / 2) * sp - sp * 0.35;
    const mat = this._makeFacadeMaterial(0x152238, COL.blue, 12);
    const trim = new THREE.MeshStandardMaterial({
      color: 0x0a101c, metalness: 0.6, roughness: 0.35,
      emissive: 0x1a4060, emissiveIntensity: 0.2,
    });
    for (const z of [zFar, zNear]) {
      for (const dx of [-sp * 1.1, 0, sp * 1.1]) {
        const h = 18 + Math.random() * 14;
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(5.5, h, 4.5), mat);
        body.position.y = h / 2;
        g.add(body);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.4, 4.8), trim);
        roof.position.y = h + 0.2;
        g.add(roof);
        g.position.set(ax + dx, 0, z);
        this._cityGroup.add(g);
      }
    }
  }

  _makeFacadeMaterial(base, glowHex, floors = 10) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = `#${base.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, 0, 128, 256);

    // Sparse windows — fewer bands so facades don't look like striped pads
    const rows = Math.max(4, Math.min(floors, 9));
    const floorPx = 256 / rows;
    const glow = `#${new THREE.Color(glowHex).getHexString()}`;
    const winCols = 3;
    const winW = 16;
    const gap = (128 - winCols * winW) / (winCols + 1);
    for (let fy = 0; fy < rows; fy++) {
      const y0 = fy * floorPx;
      for (let col = 0; col < winCols; col++) {
        if (Math.random() < 0.18) continue;
        const x = gap + col * (winW + gap);
        const lit = Math.random() > 0.35;
        const wh = floorPx * 0.42;
        const wy = y0 + floorPx * 0.32;
        ctx.globalAlpha = lit ? 0.4 + Math.random() * 0.45 : 0.55;
        ctx.fillStyle = lit ? glow : 'rgba(10,16,30,0.9)';
        ctx.fillRect(x, wy, winW, wh);
      }
    }
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;

    return new THREE.MeshStandardMaterial({
      map: tex,
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.28,
      emissive: glowHex,
      emissiveIntensity: 0.2,
      emissiveMap: tex,
    });
  }

  /** Full street: asphalt + curb + sidewalks (not a thin stripe) */
  _initStreets() {
    const sp = this._citySpacing;
    const cols = this._cityCols;
    const rows = this._cityRows;
    const asphaltW = sp * 0.48;       // driving lanes
    const walkW = sp * 0.22;          // sidewalk each side
    const curbW = 0.18;
    const half = asphaltW / 2;
    const lenZ = rows * sp + sp * 2;
    const lenX = cols * sp + sp * 2;

    const asphalt = new THREE.MeshStandardMaterial({
      color: 0x1a1e28,
      roughness: 0.92,
      metalness: 0.08,
      emissive: 0x10141c,
      emissiveIntensity: 0.2,
    });
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0x3a4254,
      roughness: 0.7,
      metalness: 0.15,
      emissive: 0x1a2030,
      emissiveIntensity: 0.15,
    });
    const walkMat = new THREE.MeshStandardMaterial({
      color: 0x2a3142,
      roughness: 0.85,
      metalness: 0.05,
      emissive: 0x152038,
      emissiveIntensity: 0.22,
    });
    const dashMat = new THREE.MeshBasicMaterial({
      color: 0xc9d6ee,
      transparent: true,
      opacity: 0.35,
    });

    this._roadGroup = new THREE.Group();
    this.scene.add(this._roadGroup);

    const addNS = (x) => {
      // asphalt
      const road = new THREE.Mesh(new THREE.BoxGeometry(asphaltW, 0.06, lenZ), asphalt);
      road.position.set(x, 0.03, 0);
      this._roadGroup.add(road);
      // curbs
      for (const side of [-1, 1]) {
        const curb = new THREE.Mesh(new THREE.BoxGeometry(curbW, 0.22, lenZ), curbMat);
        curb.position.set(x + side * (half + curbW / 2), 0.11, 0);
        this._roadGroup.add(curb);
        // sidewalk raised
        const walk = new THREE.Mesh(new THREE.BoxGeometry(walkW, 0.14, lenZ), walkMat);
        walk.position.set(x + side * (half + curbW + walkW / 2), 0.14, 0);
        this._roadGroup.add(walk);
      }
      // subtle dashed center — short segments, not one endless stripe
      const dashLen = 1.4;
      const gap = 1.8;
      for (let z = -lenZ / 2; z < lenZ / 2; z += dashLen + gap) {
        const dash = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, dashLen), dashMat);
        dash.position.set(x, 0.07, z);
        this._roadGroup.add(dash);
      }
    };

    const addEW = (z) => {
      const road = new THREE.Mesh(new THREE.BoxGeometry(lenX, 0.06, asphaltW), asphalt);
      road.position.set(0, 0.035, z);
      this._roadGroup.add(road);
      for (const side of [-1, 1]) {
        const curb = new THREE.Mesh(new THREE.BoxGeometry(lenX, 0.22, curbW), curbMat);
        curb.position.set(0, 0.115, z + side * (half + curbW / 2));
        this._roadGroup.add(curb);
        const walk = new THREE.Mesh(new THREE.BoxGeometry(lenX, 0.14, walkW), walkMat);
        walk.position.set(0, 0.145, z + side * (half + curbW + walkW / 2));
        this._roadGroup.add(walk);
      }
    };

    for (const x of this._streetAxes.ns) addNS(x);
    for (const z of this._streetAxes.ew) addEW(z);

    this._roadHalf = half;
    this._asphaltW = asphaltW;
    this._walkW = walkW;
  }

  /** Traffic lights, lamps, crosswalks — fill the empty street */
  _initStreetProps() {
    this._propGroup = new THREE.Group();
    this.scene.add(this._propGroup);
    const ns = this._streetAxes.ns || [];
    const ew = this._streetAxes.ew || [];
    const ax = ns[Math.min(1, ns.length - 1)] || 0;
    const half = this._roadHalf || 2;
    const sp = this._citySpacing || 8.2;
    const rows = this._cityRows || 15;
    const low = this._low;

    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x2a3040, metalness: 0.7, roughness: 0.35,
      emissive: 0x101820, emissiveIntensity: 0.2,
    });
    // Emissive-only bulbs — no per-lamp PointLights (kills weak GPUs)
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });

    const lampStep = low ? sp * 2.2 : this._mobile ? sp * 1.6 : sp * 1.15;
    const zSpan = (rows / 2 - 1) * sp;
    for (let z = -zSpan; z <= zSpan; z += lampStep) {
      for (const side of [-1, 1]) {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 5.2, low ? 5 : 6), poleMat);
        pole.position.y = 2.6;
        g.add(pole);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.1), poleMat);
        arm.position.set(side * -0.55, 5.0, 0);
        g.add(arm);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, low ? 6 : 8, low ? 6 : 8), lampMat);
        bulb.position.set(side * -1.1, 4.85, 0);
        g.add(bulb);
        g.position.set(ax + side * (half + 0.85), 0, z);
        this._propGroup.add(g);
      }
    }

    // One soft street fill instead of dozens of point lights
    const streetFill = new THREE.PointLight(0xffe0a0, low ? 0.55 : 0.85, low ? 40 : 55, 2);
    streetFill.position.set(ax, 7.5, 0);
    this._propGroup.add(streetFill);

    const headMat = new THREE.MeshStandardMaterial({
      color: 0x151820, metalness: 0.5, roughness: 0.4,
    });
    const red = new THREE.MeshBasicMaterial({ color: 0xff3344 });
    const amber = new THREE.MeshBasicMaterial({ color: 0xffaa22 });
    const green = new THREE.MeshBasicMaterial({ color: 0x33ff66 });

    const ewUse = low ? ew.filter((_, i) => i % 2 === 0) : ew;
    for (const ez of ewUse) {
      for (const side of [-1, 1]) {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 4.4, low ? 5 : 6), poleMat);
        pole.position.y = 2.2;
        g.add(pole);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), poleMat);
        arm.position.set(side * -0.9, 4.2, 0);
        g.add(arm);
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.05, 0.28), headMat);
        box.position.set(side * -1.9, 4.2, 0);
        g.add(box);
        const mk = (mat, oy) => {
          const d = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), mat);
          d.position.set(side * -1.9, 4.2 + oy, 0.12);
          g.add(d);
        };
        mk(red, 0.32);
        mk(amber, 0);
        mk(green, -0.32);
        g.position.set(ax + side * (half + 0.7), 0, ez + side * 1.2);
        this._propGroup.add(g);
      }
    }

    const stripeMat = new THREE.MeshBasicMaterial({
      color: 0xe8f0ff, transparent: true, opacity: 0.55,
    });
    for (const ez of ewUse) {
      for (let i = -3; i <= 3; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 2.4), stripeMat);
        s.position.set(ax + i * 0.55, 0.08, ez);
        this._propGroup.add(s);
      }
    }
  }

  /** Better sedan cars with wheels — readable from above and street level */
  _initCars() {
    this._cars = [];
    const colors = [0x3d7cff, 0xe85d04, 0x2dd4a8, 0xdbe7ff, 0xe056a0, 0x8b6cff, 0xf0c14a];
    const ns = this._streetAxes.ns;
    const ax = ns[Math.min(1, ns.length - 1)] || 0;
    const zSpan = (this._cityRows * this._citySpacing) * 0.38;
    const n = this._low ? 4 : this._mobile ? 6 : 10;
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x111418, metalness: 0.4, roughness: 0.55,
    });

    for (let i = 0; i < n; i++) {
      const body = new THREE.Group();
      const col = colors[i % colors.length];
      const paint = new THREE.MeshStandardMaterial({
        color: col, metalness: 0.65, roughness: 0.28,
        emissive: col, emissiveIntensity: 0.18,
      });
      const glass = new THREE.MeshStandardMaterial({
        color: 0x0a1528, metalness: 0.9, roughness: 0.15,
        emissive: 0x3a90ff, emissiveIntensity: 0.25,
      });

      // Lower body (car silhouette from top = rounded rectangle)
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.38, 2.35), paint);
      chassis.position.y = 0.42;
      body.add(chassis);
      // Cabin / roof
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.38, 1.15), glass);
      cabin.position.set(0, 0.78, -0.12);
      body.add(cabin);
      // Hood slope hint
      const hood = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.12, 0.55), paint);
      hood.position.set(0, 0.58, 0.78);
      body.add(hood);
      // Trunk
      const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.14, 0.4), paint);
      trunk.position.set(0, 0.55, -1.0);
      body.add(trunk);
      // Wheels
      const wheelGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.18, 10);
      for (const [wx, wz] of [[0.52, 0.7], [-0.52, 0.7], [0.52, -0.75], [-0.52, -0.75]]) {
        const wh = new THREE.Mesh(wheelGeo, wheelMat);
        wh.rotation.z = Math.PI / 2;
        wh.position.set(wx, 0.22, wz);
        body.add(wh);
      }
      // Headlights + taillights
      const hl = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.12, 0.08),
        new THREE.MeshBasicMaterial({ color: 0xfff3c4 })
      );
      hl.position.set(0.32, 0.45, 1.2);
      body.add(hl);
      const hl2 = hl.clone();
      hl2.position.x = -0.32;
      body.add(hl2);
      const tl = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.1, 0.06),
        new THREE.MeshBasicMaterial({ color: 0xff2244 })
      );
      tl.position.set(0.3, 0.48, -1.2);
      body.add(tl);
      const tl2 = tl.clone();
      tl2.position.x = -0.3;
      body.add(tl2);

      this.scene.add(body);
      this._cars.push({
        mesh: body,
        alongNS: true,
        axis: ax,
        t: i / n,
        speed: 0.01 + (i % 3) * 0.0035,
        dir: i % 2 === 0 ? 1 : -1,
        span: zSpan,
        lane: (i % 2 === 0 ? 1 : -1) * 1.2,
      });
    }

    // Arcade-style cargo trucks
    const truckColors = [0x1a6b4a, 0x2a4a7a, 0x6a2a3a, 0x3a3a4a];
    const tn = this._low ? 2 : this._mobile ? 3 : 4;
    for (let i = 0; i < tn; i++) {
      const g = new THREE.Group();
      const col = truckColors[i % truckColors.length];
      const paint = new THREE.MeshStandardMaterial({
        color: col, metalness: 0.55, roughness: 0.35,
        emissive: col, emissiveIntensity: 0.15,
      });
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.1, 1.4), paint);
      cab.position.set(0, 0.95, 1.35);
      g.add(cab);
      const window = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.45, 0.1),
        new THREE.MeshStandardMaterial({
          color: 0x0a2038, emissive: 0x4fc3f7, emissiveIntensity: 0.35, metalness: 0.8, roughness: 0.2,
        })
      );
      window.position.set(0, 1.15, 2.05);
      g.add(window);
      const trailer = new THREE.Mesh(new THREE.BoxGeometry(1.45, 1.55, 3.4), paint);
      trailer.position.set(0, 1.15, -1.1);
      g.add(trailer);
      // neon strip on trailer — tech feel
      const neon = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.08, 3.2),
        new THREE.MeshBasicMaterial({ color: 0x00ffcc })
      );
      neon.position.set(0, 1.95, -1.1);
      g.add(neon);
      const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.22, 10);
      for (const [wx, wz] of [[0.65, 1.5], [-0.65, 1.5], [0.65, -0.2], [-0.65, -0.2], [0.65, -2.2], [-0.65, -2.2]]) {
        const wh = new THREE.Mesh(wheelGeo, wheelMat);
        wh.rotation.z = Math.PI / 2;
        wh.position.set(wx, 0.28, wz);
        g.add(wh);
      }
      const hl = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.14, 0.1),
        new THREE.MeshBasicMaterial({ color: 0xfff3c4 })
      );
      hl.position.set(0.4, 0.7, 2.1);
      g.add(hl);
      const hl2 = hl.clone();
      hl2.position.x = -0.4;
      g.add(hl2);

      this.scene.add(g);
      this._cars.push({
        mesh: g,
        alongNS: true,
        axis: ax,
        t: (i + 0.35) / tn,
        speed: 0.007 + i * 0.0015,
        dir: i % 2 === 0 ? -1 : 1,
        span: zSpan * 0.92,
        lane: (i % 2 === 0 ? 1 : -1) * 1.15,
      });
    }
  }

  /** Neon video billboards — screens with static / scanline glitch */
  _initStreetBillboards() {
    const ads = [
      { title: 'SOS', sub: 'PEOPLE = NETWORK', col: '#00ffcc' },
      { title: 'PRIVATE', sub: 'NO TRACKING', col: '#2d88ff' },
      { title: 'FREE', sub: 'YOUR DATA · YOURS', col: '#2ecc71' },
      { title: 'SECURE', sub: 'END-TO-END', col: '#ff6b9d' },
      { title: 'OPEN', sub: 'NO CENTRAL TOWER', col: '#a78bfa' },
      { title: 'LIVE', sub: 'DECENTRAL FEED', col: '#ff6d00' },
      { title: 'PEER', sub: 'DIRECT LINK', col: '#4fc3f7' },
      { title: 'OWN', sub: 'YOUR IDENTITY', col: '#eaf6ff' },
    ];
    this._streetBoards = [];
    this._billboardTour = [];
    this._videoBoards = [];
    const ns = this._streetAxes.ns || [];
    const ax = ns[Math.min(1, ns.length - 1)] || 0;
    const sp = this._citySpacing || 8.2;
    const rows = this._cityRows || 15;
    const zMax = (rows / 2 - 1.5) * sp;
    const zMin = (-rows / 2 + 1.5) * sp;

    let anchors = this._billboardAnchors
      .filter((a) => Math.abs(a.x - ax) < sp * 2.4)
      .sort((a, b) => b.z - a.z);
    if (anchors.length < 4) anchors = this._billboardAnchors.slice().sort((a, b) => b.z - a.z);

    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x0a1018,
      metalness: 0.7,
      roughness: 0.3,
      emissive: 0x00ffcc,
      emissiveIntensity: 0.35,
    });

    const n = this._low ? 4 : this._mobile ? 6 : 9;
    for (let i = 0; i < n; i++) {
      const ad = ads[i % ads.length];
      const screen = this._makeVideoScreen(ad);
      const bw = 3.2;
      const bh = 1.9;
      const board = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), screen.mat);

      // Bezel / frame behind screen
      const frame = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.28, bh + 0.28, 0.12), frameMat);
      const mount = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 1.2, 0.18),
        new THREE.MeshStandardMaterial({ color: 0x222838, metalness: 0.6, roughness: 0.4 })
      );

      let x; let y; let z; let side;
      if (anchors[i]) {
        const a = anchors[i];
        side = a.x >= ax ? 1 : -1;
        x = a.x + side * (a.w * 0.51 + 0.18);
        y = Math.min(Math.max(a.y, 5.0), 9.0);
        z = a.z;
      } else {
        side = i % 2 === 0 ? 1 : -1;
        z = lerp(zMax, zMin, i / (n - 1 || 1));
        x = ax + side * (sp * 0.58);
        y = 6.2;
      }

      const group = new THREE.Group();
      board.position.z = 0.08;
      frame.position.z = 0;
      mount.position.set(0, -bh * 0.35, -0.05);
      group.add(frame);
      group.add(board);
      group.add(mount);
      group.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      group.position.set(x, y, z);
      this.scene.add(group);

      this._streetBoards.push(board);
      this._videoBoards.push(screen);
      this._billboardTour.push({ x: ax, y: y * 0.55, z, lookX: x, lookY: y, lookZ: z });
      this._paintVideoScreen(screen, i * 0.7);
    }
  }

  _makeVideoScreen(ad) {
    const c = document.createElement('canvas');
    const low = this._low;
    c.width = low ? 128 : 192;
    c.height = low ? 72 : 108;
    const ctx = c.getContext('2d', { willReadFrequently: !low });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    return {
      canvas: c,
      ctx,
      tex,
      mat,
      ad,
      phase: Math.random() * 100,
      lastDraw: 0,
    };
  }

  _paintVideoScreen(vb, t) {
    const { ctx, canvas: c, ad, tex } = vb;
    const W = c.width;
    const H = c.height;
    const time = t + vb.phase;
    const low = this._low;

    ctx.fillStyle = '#041018';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ad.col;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;

    // Moving blocks (cheap "video")
    const blocks = low ? 2 : 4;
    ctx.globalAlpha = 0.4;
    for (let i = 0; i < blocks; i++) {
      const bx = ((time * (18 + i * 10) + i * 36) % (W + 36)) - 18;
      const by = (Math.sin(time * 0.7 + i) * 0.5 + 0.5) * (H - 24);
      ctx.fillStyle = i % 2 ? ad.col : '#ffffff';
      ctx.fillRect(bx, by, 22 + i * 5, 10);
    }
    ctx.globalAlpha = 1;

    // Scanlines — fewer on weak devices
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    const step = low ? 5 : 3;
    for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);

    const roll = ((time * 50) % (H + 16)) - 8;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, roll, W, 8);

    // Cheap static: random white bars — NEVER getImageData on weak GPUs
    if ((Math.sin(time * 3.1) * Math.sin(time * 7.7)) > 0.7 || Math.random() > 0.93) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#cfd8e8';
      const streaks = low ? 6 : 14;
      for (let i = 0; i < streaks; i++) {
        ctx.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 18, 1 + Math.random() * 3);
      }
      ctx.globalAlpha = 1;
      if (!low && Math.random() > 0.55) {
        const ty = (Math.random() * H) | 0;
        const shift = ((Math.random() * 28) | 0) - 14;
        ctx.drawImage(c, 0, ty, W, 6, shift, ty, W, 6);
      }
    }

    ctx.strokeStyle = ad.col;
    ctx.lineWidth = 2;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(8, H * 0.28, W - 16, H * 0.42);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = low ? '900 16px Orbitron, Impact, sans-serif' : '900 22px Orbitron, Impact, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(ad.title, W / 2, H * 0.42);
    ctx.font = low ? '700 8px Orbitron, sans-serif' : '700 10px Orbitron, sans-serif';
    ctx.fillStyle = ad.col;
    ctx.fillText(ad.sub, W / 2, H * 0.62);

    ctx.fillStyle = Math.sin(time * 6) > 0 ? '#ff3355' : 'rgba(255,50,80,0.25)';
    ctx.beginPath();
    ctx.arc(12, 11, 3, 0, Math.PI * 2);
    ctx.fill();

    tex.needsUpdate = true;
  }

  _initConnections() {
    if (this._low) {
      this._connUniforms = { uTime: { value: 0 }, uDraw: { value: 0 } };
      this._connLines = null;
      return;
    }
    const n = Math.round(clamp(24 * this.quality, 12, 32));
    const positions = new Float32Array(n * 2 * 3);
    const progress = new Float32Array(n);
    this._connPairs = [];
    for (let i = 0; i < n; i++) {
      const a = this._nodes[(Math.random() * this._nodes.length) | 0];
      const b = this._nodes[(Math.random() * this._nodes.length) | 0];
      this._connPairs.push({ a, b });
      progress[i] = Math.random();
      const o = i * 6;
      positions[o] = a.x; positions[o + 1] = a.y; positions[o + 2] = a.z;
      positions[o + 3] = b.x; positions[o + 4] = b.y; positions[o + 5] = b.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const uniforms = {
      uTime: { value: 0 },
      uDraw: { value: 0 },
      uColor: { value: new THREE.Color(COL.aqua) },
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms,
      vertexShader: `
        uniform float uTime; uniform float uDraw;
        varying float vA;
        void main(){
          vA = uDraw;
          vec3 p = position;
          p.y += sin(uTime * 2.0 + position.x * 0.05) * 0.4 * uDraw;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main(){
          gl_FragColor = vec4(uColor, 0.55 * vA);
        }`,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.visible = false; // no neon stripes between buildings — distracts from the fly-through
    this.scene.add(lines);
    this._connUniforms = uniforms;
    this._connLines = lines;
  }

  _initPackets() {
    if (this._low) {
      this._packets = null;
      this._packetMat = { opacity: 0 };
      this._packetData = [];
      return;
    }
    const count = Math.round(clamp(28 * this.quality, 16, 40));
    const geo = new THREE.SphereGeometry(0.35, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: COL.aqua,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.visible = false; // hide packet streaks between buildings
    this._packetData = [];
    for (let i = 0; i < count; i++) {
      const a = this._nodes[(Math.random() * this._nodes.length) | 0];
      const b = this._nodes[(Math.random() * this._nodes.length) | 0];
      this._packetData.push({ a, b, t: Math.random(), speed: 0.15 + Math.random() * 0.35 });
    }
    this.scene.add(mesh);
    this._packets = mesh;
    this._packetMat = mat;
  }

  _initParticles() {
    if (this._low) {
      this._particles = null;
      this._particleVel = null;
      return;
    }
    const n = Math.round(clamp(70 * this.quality, 36, 100));
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 320;
      pos[i * 3 + 1] = Math.random() * 120;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 320;
      vel[i] = 1 + Math.random() * 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.55,
      color: 0x9fd8ff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      map: this._makeDotTexture(),
    });
    this._particles = new THREE.Points(geo, mat);
    this._particleVel = vel;
    this.scene.add(this._particles);
  }

  _makeDotTexture() {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(160,220,255,0.7)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* ---- Commercial brand cards: P2P / TORRENT / BLOSSOM / RELAY ---- */
  _initBrandCards() {
    const brands = [
      {
        id: 'p2p',
        title: 'P2P',
        sub: 'PEER TO PEER',
        he: 'חיבור ישיר בין מכשירים',
        col: '#00ffcc',
        accent: '#2d88ff',
        start: 6,
        end: 13,
        draw: (ctx, W, H, col) => this._drawP2PMark(ctx, W, H, col),
      },
      {
        id: 'torrent',
        title: 'TORRENT',
        sub: 'DISTRIBUTED TRANSFER',
        he: 'העברת פוסטים וקבצים מבוזרת',
        col: '#2ecc71',
        accent: '#27ae60',
        start: 13,
        end: 20,
        draw: (ctx, W, H, col) => this._drawTorrentMark(ctx, W, H, col),
      },
      {
        id: 'blossom',
        title: 'BLOSSOM',
        sub: 'MEDIA SERVERS',
        he: 'שרתי מדיה מבוזרים',
        col: '#ff6b9d',
        accent: '#ff8fab',
        start: 20,
        end: 27,
        draw: (ctx, W, H, col) => this._drawBlossomMark(ctx, W, H, col),
      },
      {
        id: 'relay',
        title: 'RELAY',
        sub: 'NETWORK RELAYS',
        he: 'תחנות ממסר לרשת',
        col: '#7c5cff',
        accent: '#a78bfa',
        start: 27,
        end: 34,
        draw: (ctx, W, H, col) => this._drawRelayMark(ctx, W, H, col),
      },
    ];

    this._brands = [];
    const ax = (this._streetAxes && this._streetAxes.ns && this._streetAxes.ns[1]) || 0;
    const sp = this._citySpacing || 8.2;
    // Signs along the same avenue the camera glides through
    const slots = [
      { x: ax + 4.0, y: 5.2, z: sp * 3.2, rotY: -Math.PI / 2 },
      { x: ax - 4.0, y: 5.0, z: sp * 1.0, rotY: Math.PI / 2 },
      { x: ax + 4.0, y: 5.3, z: -sp * 1.2, rotY: -Math.PI / 2 },
      { x: ax - 4.0, y: 5.1, z: -sp * 3.0, rotY: Math.PI / 2 },
    ];
    brands.forEach((b, i) => {
      const slot = slots[i % slots.length];
      const tex = this._makeBrandTexture(b);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.55), mat);
      mesh.position.set(slot.x, slot.y, slot.z);
      mesh.rotation.y = slot.rotY;
      this.scene.add(mesh);

      this._brands.push({
        ...b,
        sprite: mesh,
        mat,
        glow: null,
        glowMat: { opacity: 0 },
        baseY: slot.y,
      });
      if (!this._billboardTour) this._billboardTour = [];
      this._billboardTour.push({
        x: ax, y: slot.y * 0.6, z: slot.z,
        lookX: slot.x, lookY: slot.y, lookZ: slot.z,
      });
    });
  }

  _makeBrandTexture(b) {
    const W = 768; const H = 480;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // Glass card
    const grd = ctx.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, 'rgba(10,16,40,0.92)');
    grd.addColorStop(1, 'rgba(8,12,28,0.88)');
    this._roundRect(ctx, 16, 16, W - 32, H - 32, 36);
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.strokeStyle = b.col;
    ctx.lineWidth = 4;
    this._roundRect(ctx, 16, 16, W - 32, H - 32, 36);
    ctx.stroke();

    // Inner glow border
    ctx.strokeStyle = b.accent;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    this._roundRect(ctx, 28, 28, W - 56, H - 56, 28);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Logo mark
    b.draw(ctx, W, H, b.col);

    // Title
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 64px Orbitron, Montserrat, Arial Black, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = b.col;
    ctx.shadowBlur = 24;
    ctx.fillText(b.title, W / 2, H * 0.58);
    ctx.shadowBlur = 0;

    ctx.font = '700 26px Orbitron, Assistant, sans-serif';
    ctx.fillStyle = b.col;
    ctx.letterSpacing = '4px';
    ctx.fillText(b.sub, W / 2, H * 0.70);

    ctx.font = '600 28px Assistant, Rubik, Heebo, sans-serif';
    ctx.fillStyle = 'rgba(234,246,255,0.9)';
    ctx.direction = 'rtl';
    ctx.fillText(b.he, W / 2, H * 0.82);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  _drawP2PMark(ctx, W, H, col) {
    const cx = W / 2; const cy = H * 0.32;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 5;
    const pts = [
      [cx - 70, cy + 20], [cx, cy - 40], [cx + 70, cy + 20],
      [cx - 40, cy + 50], [cx + 40, cy + 50],
    ];
    // nodes
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, TAU);
      ctx.fill();
    }
    // links
    ctx.globalAlpha = 0.85;
    const links = [[0, 1], [1, 2], [0, 2], [0, 3], [2, 4], [3, 4], [1, 3], [1, 4]];
    for (const [a, b] of links) {
      ctx.beginPath();
      ctx.moveTo(pts[a][0], pts[a][1]);
      ctx.lineTo(pts[b][0], pts[b][1]);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawTorrentMark(ctx, W, H, col) {
    const cx = W / 2; const cy = H * 0.30;
    ctx.fillStyle = col;
    // Magnet / torrent arrows stylized
    ctx.beginPath();
    ctx.moveTo(cx, cy - 55);
    ctx.lineTo(cx + 55, cy + 15);
    ctx.lineTo(cx + 22, cy + 15);
    ctx.lineTo(cx + 22, cy + 55);
    ctx.lineTo(cx - 22, cy + 55);
    ctx.lineTo(cx - 22, cy + 15);
    ctx.lineTo(cx - 55, cy + 15);
    ctx.closePath();
    ctx.fill();
    // checkered accent (BitTorrent-inspired)
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(cx - 18, cy + 20, 18, 18);
    ctx.fillRect(cx, cy + 38, 18, 18);
  }

  _drawBlossomMark(ctx, W, H, col) {
    const cx = W / 2; const cy = H * 0.30;
    ctx.fillStyle = col;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const x = cx + Math.cos(a) * 38;
      const y = cy + Math.sin(a) * 28;
      ctx.beginPath();
      ctx.ellipse(x, y, 22, 14, a, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#ffe0ec';
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, TAU);
    ctx.fill();
  }

  _drawRelayMark(ctx, W, H, col) {
    const cx = W / 2; const cy = H * 0.36;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 6;
    // tower
    ctx.beginPath();
    ctx.moveTo(cx, cy - 60);
    ctx.lineTo(cx + 28, cy + 50);
    ctx.lineTo(cx - 28, cy + 50);
    ctx.closePath();
    ctx.fill();
    // waves
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.9;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy - 40, 18 * i, -1.1, -0.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - 40, 18 * i, 0.2, 1.1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _initVoiceWave() {
    const a = this._nodes[3 % this._nodes.length];
    const b = this._nodes[11 % this._nodes.length];
    this._voiceA = a; this._voiceB = b;
    const bars = 26;
    const geo = new THREE.BoxGeometry(0.18, 1, 0.18);
    const mat = new THREE.MeshBasicMaterial({
      color: COL.aqua, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, bars);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this._voiceMesh = mesh;
    this._voiceMat = mat;
    this._voiceBars = bars;
    this._voiceSeed = new Float32Array(bars);
    for (let i = 0; i < bars; i++) this._voiceSeed[i] = Math.random();
  }

  _initVideoCall() {
    const a = this._nodes[5 % this._nodes.length];
    const b = this._nodes[21 % this._nodes.length];
    const g = new THREE.BufferGeometry();
    const p = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]);
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const m = new THREE.LineBasicMaterial({
      color: COL.sky, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._callLine = new THREE.Line(g, m);
    this._callLine.visible = false;
    this.scene.add(this._callLine);
    this._callMat = m;
    const sg = new THREE.SphereGeometry(0.7, 14, 14);
    const sm = new THREE.MeshBasicMaterial({
      color: COL.sky, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._callE1 = new THREE.Mesh(sg, sm.clone());
    this._callE1.position.set(a.x, a.y, a.z);
    this._callE2 = new THREE.Mesh(sg, sm.clone());
    this._callE2.position.set(b.x, b.y, b.z);
    this.scene.add(this._callE1);
    this.scene.add(this._callE2);
    this._callEMat = sm;
  }

  _initRelays() {
    const count = Math.round(clamp(10 * this.quality, 6, 14));
    const geo = new THREE.ConeGeometry(1.1, 4.2, 7);
    const mat = new THREE.MeshStandardMaterial({
      color: COL.relay,
      emissive: COL.relay,
      emissiveIntensity: 0.8,
      metalness: 0.5,
      roughness: 0.3,
      transparent: true,
      opacity: 0,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const nd = this._nodes[(i * 17 + 5) % this._nodes.length];
      p.set(nd.x, nd.y + 2.8, nd.z);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this._relayMesh = mesh;
    this._relayMat = mat;
  }

  _initBlossomNodes() {
    const count = Math.round(clamp(12 * this.quality, 8, 16));
    const geo = new THREE.SphereGeometry(1.4, 16, 16);
    const mat = new THREE.MeshStandardMaterial({
      color: COL.blossom,
      emissive: COL.blossom,
      emissiveIntensity: 0.9,
      metalness: 0.2,
      roughness: 0.35,
      transparent: true,
      opacity: 0,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const q = new THREE.Quaternion();
    this._blossomPos = [];
    for (let i = 0; i < count; i++) {
      const nd = this._nodes[(i * 13 + 9) % this._nodes.length];
      p.set(nd.x + 2, nd.y + 5, nd.z - 2);
      this._blossomPos.push(p.clone());
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this._blossomMesh = mesh;
    this._blossomMat = mat;
  }

  _sOutline(ox, oy, scale) {
    const pts = [];
    const seg = 16;
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI;
      pts.push([ox + Math.cos(t) * scale, oy + 0.55 * scale + Math.sin(t) * scale]);
    }
    pts.push([ox - 1 * scale, oy + 0.55 * scale]);
    pts.push([ox + 1 * scale, oy - 0.55 * scale]);
    for (let i = 0; i <= seg; i++) {
      const t = -(i / seg) * Math.PI;
      pts.push([ox + Math.cos(t) * scale, oy - 0.55 * scale + Math.sin(t) * scale]);
    }
    return pts;
  }

  _oOutline(ox, oy, scale) {
    const pts = [];
    const seg = 30;
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * TAU;
      pts.push([ox + Math.cos(t) * scale, oy + Math.sin(t) * scale * 1.3]);
    }
    return pts;
  }

  _initLogo() {
    const scale = 3.0;
    const layout = [
      { pts: this._sOutline(-2.7 * scale * 0.55, 0, scale), col: new THREE.Color(COL.sky) },
      { pts: this._oOutline(0, 0, scale), col: new THREE.Color(COL.orange) },
      { pts: this._sOutline(2.7 * scale * 0.55, 0, scale), col: new THREE.Color(COL.sky) },
    ];
    const targets = [];
    const segs = [];
    layout.forEach((L) => {
      const base = targets.length;
      L.pts.forEach((p) => targets.push({ x: p[0], y: p[1], z: 0, col: L.col }));
      for (let i = 0; i < L.pts.length - 1; i++) segs.push([base + i, base + i + 1, L.col]);
    });
    const nSeg = segs.length;
    const positions = new Float32Array(nSeg * 2 * 3);
    const colors = new Float32Array(nSeg * 2 * 3);
    const start = new Float32Array(nSeg * 2 * 3);
    for (let i = 0; i < nSeg; i++) {
      const [, , col] = segs[i];
      for (const k of [0, 1]) {
        const nd = this._nodes[(Math.random() * this._nodes.length) | 0];
        const idx = (i * 2 + k) * 3;
        start[idx] = nd.x; start[idx + 1] = nd.y; start[idx + 2] = nd.z;
        const o = (i * 2 + k) * 3;
        colors[o] = col.r; colors[o + 1] = col.g; colors[o + 2] = col.b;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const m = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._logo = new THREE.LineSegments(g, m);
    this._logo.frustumCulled = false;
    this._logo.position.set(0, 34, 0);
    this.scene.add(this._logo);
    this._logoMat = m;
    this._logoStart = start;
    this._logoTargets = targets;
    this._logoSegs = segs;
    const gt = this._makeDotTexture();
    const gm = new THREE.SpriteMaterial({
      map: gt, color: 0x2d88ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._logoGlow = new THREE.Sprite(gm);
    this._logoGlow.scale.set(44, 44, 1);
    this._logoGlow.position.set(0, 34, -2);
    this.scene.add(this._logoGlow);
    this._logoGlowMat = gm;
  }

  _initCameraPath() {
    // Dead-simple slow path: no look snaps, no side glances, no sharp yaw
    const sp = this._citySpacing || 8.2;
    const rows = this._cityRows || 15;
    const ns = (this._streetAxes && this._streetAxes.ns) || [];
    const ax = ns.length ? ns[Math.min(1, ns.length - 1)] : 0;
    // Stay well inside the city so signs stay in frame
    const zStart = (rows / 2 - 2.2) * sp;
    const zEnd = (-rows / 2 + 2.6) * sp;

    this._camPath = {
      ax,
      zStart,
      zEnd,
      yStart: 42,   // not too high — less dramatic pitch change
      yEye: 5.2,
      lookAhead: 16,
    };
    this._camPosSmooth = new THREE.Vector3(ax, 42, zStart);
    this._camLookSmooth = new THREE.Vector3(ax, 8, zStart - 16);
    this._camLastT = performance.now();
    // Snap camera to start pose so frame 0 has zero whip
    this.camera.position.copy(this._camPosSmooth);
    this.camera.lookAt(this._camLookSmooth);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  play() {
    if (this._running) return Promise.resolve();
    this._running = true;
    window.addEventListener('resize', this._onResize, { passive: true });
    this._tStart = performance.now();
    this._camLastT = this._tStart;
    if (this._camPath) {
      this._camPosSmooth.set(this._camPath.ax, this._camPath.yStart, this._camPath.zStart);
      this._camLookSmooth.set(this._camPath.ax, 8, this._camPath.zStart - this._camPath.lookAhead);
      this.camera.position.copy(this._camPosSmooth);
      this.camera.lookAt(this._camLookSmooth);
    }
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._loop();
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    try {
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mm = o.material;
          (Array.isArray(mm) ? mm : [mm]).forEach((x) => {
            Object.values(x).forEach((v) => v && v.isTexture && v.dispose());
            x.dispose();
          });
        }
      });
    } catch (e) {}
    try { this.renderer.dispose(); } catch (e) {}
  }

  _finish(skipped) {
    if (!this._running && !this._holdSignaled) return;
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._onPhase('done');
    this._onProgress(1);
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      r(skipped);
    }
  }

  _loop = () => {
    if (!this._running) return;
    let t = (performance.now() - this._tStart) / 1000;
    if (t >= this.duration) t = this.duration;
    this._update(t);
    try { this.renderer.render(this.scene, this.camera); }
    catch (e) { this._finish(true); return; }
    this._onProgress(clamp(t / this.duration, 0, 1));
    if (t >= this.duration) {
      if (!this._holdSignaled) {
        this._holdSignaled = true;
        this._onPhase('loading');
      }
      // Freeze final frame — no infinite loop
      return;
    }
    this._raf = requestAnimationFrame(this._loop);
  };

  complete() { this._finish(false); }

  _update(t) {
    const tmp = this._tmp;
    const D = this.duration;

    const reveal = smoothstep(0.2, 2.2, t);
    if (this._cityUniforms) {
      this._cityUniforms.uTime.value = t;
      this._cityUniforms.uReveal.value = reveal;
    }
    // Ultra-slow glide: always look DOWN THE STREET (never whip toward side signs)
    const p = this._camPath;
    const now = performance.now();
    const dt = clamp((now - (this._camLastT || now)) / 1000, 0.001, 0.05);
    this._camLastT = now;

    // Linear time — no ease that rushes the middle
    const u = clamp(t / D, 0, 1);

    // First ~30% of time: mostly descend, barely crawl forward
    // Rest: slow cruise past billboards at street height
    const descendU = clamp(u / 0.32, 0, 1);
    const descend = descendU * descendU * (3 - 2 * descendU); // smoothstep
    const driveU = clamp((u - 0.12) / 0.88, 0, 1);
    const drive = driveU * driveU * (3 - 2 * driveU);

    const y = lerp(p.yStart, p.yEye, descend);
    const z = lerp(p.zStart, p.zEnd, drive);

    // Look ALWAYS forward along the avenue — tiny continuous drift only (no sign snaps)
    const lookY = lerp(10, 4.6, descend);
    const lookZ = z - p.lookAhead;
    const sway = Math.sin(u * Math.PI * 2.0) * 0.25; // almost invisible

    if (!this._camTargetPos) this._camTargetPos = new THREE.Vector3();
    if (!this._camTargetLook) this._camTargetLook = new THREE.Vector3();
    this._camTargetPos.set(p.ax, y, z);
    this._camTargetLook.set(p.ax + sway, lookY, lookZ);

    // Very heavy smoothing — kills any residual sharpness
    const follow = 1 - Math.exp(-1.1 * dt);
    this._camPosSmooth.lerp(this._camTargetPos, follow);
    this._camLookSmooth.lerp(this._camTargetLook, follow);
    this._camPosSmooth.x = p.ax;

    this.camera.position.copy(this._camPosSmooth);
    this.camera.lookAt(this._camLookSmooth);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();

    if (!this._streetLamp) {
      this._streetLamp = new THREE.PointLight(0x88aaff, this._low ? 0.7 : 1.0, this._low ? 42 : 55, 2);
      this.scene.add(this._streetLamp);
    }
    this._streetLamp.position.set(p.ax, 8.5, this._camPosSmooth.z - 3);
    this._streetLamp.intensity = this._low ? 0.75 : 1.0;

    // Slow cars
    if (this._cars) {
      for (const car of this._cars) {
        car.t = (car.t + car.speed * 0.005) % 1;
        const cp = (car.t * 2 - 1) * car.span * car.dir;
        car.mesh.position.set(car.axis + car.lane, 0, cp);
        car.mesh.rotation.y = car.dir > 0 ? 0 : Math.PI;
      }
    }

    // Connections / packets stay hidden (no stripes between buildings)
    if (this._connUniforms) this._connUniforms.uDraw.value = 0;
    if (this._packetMat) this._packetMat.opacity = 0;

    // Soft ambient particles (skipped on low-power)
    if (this._particles && this._particleVel) {
      const ppos = this._particles.geometry.attributes.position.array;
      const pvel = this._particleVel;
      for (let i = 0; i < pvel.length; i++) {
        ppos[i * 3 + 1] += pvel[i] * 0.016;
        if (ppos[i * 3 + 1] > 120) {
          ppos[i * 3 + 1] = 0;
          ppos[i * 3] = (Math.random() - 0.5) * 320;
          ppos[i * 3 + 2] = (Math.random() - 0.5) * 320;
        }
      }
      this._particles.geometry.attributes.position.needsUpdate = true;
      this._particles.material.opacity = 0.14 * (1 - smoothstep(D - 4, D - 2, t));
    }

    if (this._brands && this._brands.length) {
      for (const b of this._brands) {
        b.mat.opacity = 0.9;
        b.sprite.position.y = b.baseY;
      }
    }

    if (this._voiceMat) this._voiceMat.opacity = 0;
    if (this._callMat) this._callMat.opacity = 0;
    if (this._callEMat) this._callEMat.opacity = 0;

    if (this._blossomMesh && this._blossomPos) {
      this._blossomMat.opacity = 0.2 * smoothstep(10.5, 12.0, t) * (1 - smoothstep(D - 5, D - 3, t));
      if (this._blossomMat.opacity > 0.01) {
        for (let i = 0; i < this._blossomPos.length; i++) {
          const bp = this._blossomPos[i];
          tmp.p.set(bp.x, bp.y, bp.z);
          tmp.s.set(1, 1, 1);
          tmp.m.compose(tmp.p, tmp.q, tmp.s);
          this._blossomMesh.setMatrixAt(i, tmp.m);
        }
        this._blossomMesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (this._relayMat) {
      this._relayMat.opacity = 0.15 * smoothstep(14.5, 16.0, t) * (1 - smoothstep(D - 4.5, D - 2.5, t));
    }

    if (this._logo && this._logoMat) {
      const lf = smoothstep(D - 3.5, D - 1.0, t);
      this._logoMat.opacity = 0.3 * smoothstep(D - 3.8, D - 2.5, t);
      this._logoGlowMat.opacity = 0.15 * smoothstep(D - 3.5, D - 2.0, t);
      if (lf > 0.001) {
        const pos = this._logo.geometry.attributes.position.array;
        const st = this._logoStart;
        const tg = this._logoTargets;
        const e = easeOut(lf);
        for (let i = 0; i < this._logoSegs.length; i++) {
          const [ai, bi] = this._logoSegs[i];
          for (const k of [0, 1]) {
            const idx = (i * 2 + k) * 3;
            const tIdx = k === 0 ? ai : bi;
            const tgP = tg[tIdx];
            pos[idx] = lerp(st[idx], tgP.x, e);
            pos[idx + 1] = lerp(st[idx + 1], tgP.y + 34, e);
            pos[idx + 2] = lerp(st[idx + 2], tgP.z, e);
          }
        }
        this._logo.geometry.attributes.position.needsUpdate = true;
      }
    }

    if (this._groundMat) {
      this._groundMat.emissiveIntensity = 0.22 + 0.08 * Math.sin(t * 1.1);
    }

    // Stagger video-board redraws (1–2 per frame max)
    if (this._videoBoards && this._videoBoards.length) {
      const interval = this._low ? 0.28 : this._mobile ? 0.16 : 0.1;
      const budget = this._low ? 1 : 2;
      let painted = 0;
      if (this._vbCursor == null) this._vbCursor = 0;
      const len = this._videoBoards.length;
      for (let n = 0; n < len && painted < budget; n++) {
        const i = (this._vbCursor + n) % len;
        const vb = this._videoBoards[i];
        if (t - vb.lastDraw > interval) {
          vb.lastDraw = t;
          this._paintVideoScreen(vb, t);
          painted++;
          this._vbCursor = (i + 1) % len;
        }
      }
    }

    if (this._stars) {
      this._stars.rotation.y = t * 0.003;
      if (!this._low) this._stars.material.opacity = 0.85 + 0.1 * Math.sin(t * 0.6);
    }
  }
}
