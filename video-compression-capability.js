// חלק בדיקה (video-compression-capability.js) – probe קריאה בלבד; לא דחיסה חיה | HYPER CORE TECH
(function initVideoCompressionCapability(root) {
  const App = root.NostrApp || (root.NostrApp = {});

  const STATUS = {
    SUPPORTED: 'SUPPORTED',
    UNSUPPORTED: 'UNSUPPORTED',
    NOT_VERIFIED: 'NOT VERIFIED',
    ERROR: 'ERROR',
  };

  const TARGET_SHORT_EDGE = 720;
  const TARGET_LONG_EDGE = 1280;

  function even(n) {
    const v = Math.max(2, Math.round(Number(n) || 0));
    return v - (v % 2);
  }

  function computeVideoBenchmarkGeometry(width, height) {
    const w = Math.max(0, Math.round(Number(width) || 0));
    const h = Math.max(0, Math.round(Number(height) || 0));
    const shortEdge = Math.min(w, h);
    const longEdge = Math.max(w, h);
    const withinTarget =
      w > 0 && h > 0 && shortEdge <= TARGET_SHORT_EDGE && longEdge <= TARGET_LONG_EDGE;
    if (!w || !h || withinTarget) {
      return {
        width: w,
        height: h,
        shortEdge,
        longEdge,
        scaled: false,
        withinTarget: !!(w && h && withinTarget),
        scale: 1,
      };
    }
    const scale = Math.min(TARGET_SHORT_EDGE / shortEdge, TARGET_LONG_EDGE / longEdge);
    const outW = even(w * scale);
    const outH = even(h * scale);
    return {
      width: outW,
      height: outH,
      shortEdge: Math.min(outW, outH),
      longEdge: Math.max(outW, outH),
      scaled: true,
      withinTarget: false,
      scale,
    };
  }

  function isNativeShell() {
    try {
      if (root.SOS_NATIVE_SHELL) return true;
      if (root.document?.documentElement?.getAttribute('data-sos-native') === '1') return true;
      if (/SOSNativeShell\//i.test(root.navigator?.userAgent || '')) return true;
      if (root.SosNativeShell && typeof root.SosNativeShell.isNativeShell === 'function') {
        const v = root.SosNativeShell.isNativeShell();
        return v === true || v === 'true';
      }
    } catch (_) {}
    return false;
  }

  function detectPlatform() {
    const nav = root.navigator || {};
    const ua = String(nav.userAgent || '');
    const nativeShell = isNativeShell();
    let uaDataMobile = null;
    let uaDataPlatform = '';
    try {
      if (nav.userAgentData) {
        uaDataMobile = typeof nav.userAgentData.mobile === 'boolean' ? nav.userAgentData.mobile : null;
        uaDataPlatform = String(nav.userAgentData.platform || '');
      }
    } catch (_) {}
    const touchPoints = Number(nav.maxTouchPoints || 0);
    const isIOSUA = /iphone|ipad|ipod/i.test(ua);
    const isIPadOS = nav.platform === 'MacIntel' && touchPoints > 1;
    const isAndroidUA = /android/i.test(ua);
    const isSafariUA = /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edgios|opios/i.test(ua);
    const isIOS = isIOSUA || isIPadOS;
    const isAndroid = isAndroidUA || nativeShell;

    let label = 'unknown';
    if (nativeShell) label = 'android-webview-sos-shell';
    else if (isIOS) label = isSafariUA || isIPadOS ? 'ios-safari' : 'ios-other';
    else if (isAndroidUA) label = 'android-chrome';
    else label = 'desktop';

    return {
      label,
      desktop: label === 'desktop',
      android: isAndroid,
      ios: isIOS,
      nativeShell,
      uaDataMobile,
      uaDataPlatform,
      touchPoints,
      isSafari: isSafariUA,
    };
  }

  function probeCtor(name) {
    try {
      const v = root[name];
      if (typeof v === 'function') return { status: STATUS.SUPPORTED, detail: 'typeof=function' };
      if (typeof v === 'undefined') return { status: STATUS.UNSUPPORTED, detail: 'typeof=undefined' };
      return { status: STATUS.NOT_VERIFIED, detail: 'typeof=' + typeof v };
    } catch (err) {
      return { status: STATUS.ERROR, detail: String(err && err.message || err) };
    }
  }

  function probeSharedArrayBuffer() {
    try {
      const t = typeof root.SharedArrayBuffer;
      if (t !== 'function') {
        return { status: STATUS.UNSUPPORTED, typeofValue: t, construct: false };
      }
      try {
        const buf = new root.SharedArrayBuffer(8);
        const ok = !!(buf && buf.byteLength === 8);
        return { status: ok ? STATUS.SUPPORTED : STATUS.UNSUPPORTED, typeofValue: t, construct: ok };
      } catch (err) {
        return {
          status: STATUS.UNSUPPORTED,
          typeofValue: t,
          construct: false,
          detail: String(err && err.message || err),
        };
      }
    } catch (err) {
      return { status: STATUS.ERROR, detail: String(err && err.message || err) };
    }
  }

  function probeIsolation() {
    let isolated = null;
    try {
      isolated = !!root.crossOriginIsolated;
    } catch (_) {
      isolated = null;
    }
    return {
      crossOriginIsolated: isolated === null
        ? { status: STATUS.NOT_VERIFIED, value: null }
        : { status: isolated ? STATUS.SUPPORTED : STATUS.UNSUPPORTED, value: isolated },
      SharedArrayBuffer: probeSharedArrayBuffer(),
    };
  }

  function probeMedia() {
    const mediaProto = root.HTMLMediaElement && root.HTMLMediaElement.prototype;
    const canvasProto = root.HTMLCanvasElement && root.HTMLCanvasElement.prototype;
    let captureStream = STATUS.NOT_VERIFIED;
    let mozCaptureStream = STATUS.UNSUPPORTED;
    if (mediaProto) {
      captureStream = typeof mediaProto.captureStream === 'function' ? STATUS.SUPPORTED : STATUS.UNSUPPORTED;
      mozCaptureStream = typeof mediaProto.mozCaptureStream === 'function' ? STATUS.SUPPORTED : STATUS.UNSUPPORTED;
    }
    let canvasCapture = STATUS.NOT_VERIFIED;
    if (canvasProto) {
      canvasCapture = typeof canvasProto.captureStream === 'function' ? STATUS.SUPPORTED : STATUS.UNSUPPORTED;
    }
    return {
      MediaRecorder: probeCtor('MediaRecorder'),
      captureStream: { status: captureStream },
      mozCaptureStream: { status: mozCaptureStream },
      canvasCaptureStream: { status: canvasCapture },
    };
  }

  const WEBCODECS_PROFILES = [
    {
      id: 'A',
      label: '720x1280 ~1.2 Mbps',
      config: {
        codec: 'avc1.4D401F',
        width: 720,
        height: 1280,
        framerate: 30,
        bitrate: 1_200_000,
        hardwareAcceleration: 'prefer-hardware',
        avc: { format: 'avc' },
      },
    },
    {
      id: 'B',
      label: '1280x720 ~1.5 Mbps',
      config: {
        codec: 'avc1.4D401F',
        width: 1280,
        height: 720,
        framerate: 30,
        bitrate: 1_500_000,
        hardwareAcceleration: 'prefer-hardware',
        avc: { format: 'avc' },
      },
    },
    {
      id: 'C',
      label: '1920x1080 ~2.5 Mbps',
      config: {
        codec: 'avc1.4D4028',
        width: 1920,
        height: 1080,
        framerate: 30,
        bitrate: 2_500_000,
        hardwareAcceleration: 'prefer-hardware',
        avc: { format: 'avc' },
      },
    },
  ];

  async function probeOneEncoderConfig(VideoEncoderCtor, profile) {
    const result = {
      id: profile.id,
      label: profile.label,
      requested: profile.config,
      supported: STATUS.NOT_VERIFIED,
      config: null,
      exception: null,
      hardwareAccelerationAccepted: STATUS.NOT_VERIFIED,
    };
    try {
      const probe = await VideoEncoderCtor.isConfigSupported(profile.config);
      result.config = probe && probe.config ? probe.config : null;
      result.supported = probe && probe.supported === true ? STATUS.SUPPORTED : STATUS.UNSUPPORTED;
      const hw = result.config && result.config.hardwareAcceleration;
      if (hw == null) result.hardwareAccelerationAccepted = STATUS.NOT_VERIFIED;
      else if (hw === 'prefer-hardware' || hw === 'no-preference') result.hardwareAccelerationAccepted = STATUS.SUPPORTED;
      else result.hardwareAccelerationAccepted = STATUS.UNSUPPORTED;
    } catch (err) {
      result.supported = STATUS.ERROR;
      result.exception = String(err && err.message || err);
    }
    return result;
  }

  async function probeWebCodecsVideoConfigs() {
    const VideoEncoderCtor = root.VideoEncoder;
    if (typeof VideoEncoderCtor !== 'function' || typeof VideoEncoderCtor.isConfigSupported !== 'function') {
      return {
        encoder: STATUS.UNSUPPORTED,
        profiles: WEBCODECS_PROFILES.map((p) => ({
          id: p.id,
          label: p.label,
          requested: p.config,
          supported: STATUS.UNSUPPORTED,
          config: null,
          exception: 'VideoEncoder.isConfigSupported missing',
          hardwareAccelerationAccepted: STATUS.UNSUPPORTED,
        })),
      };
    }
    const profiles = [];
    for (let i = 0; i < WEBCODECS_PROFILES.length; i += 1) {
      profiles.push(await probeOneEncoderConfig(VideoEncoderCtor, WEBCODECS_PROFILES[i]));
    }
    return { encoder: STATUS.SUPPORTED, profiles };
  }

  function probeVideoCompressionCapabilities() {
    const platform = detectPlatform();
    const isolation = probeIsolation();
    const report = {
      at: new Date().toISOString(),
      platform,
      video: {
        VideoEncoder: probeCtor('VideoEncoder'),
        VideoDecoder: probeCtor('VideoDecoder'),
        VideoFrame: probeCtor('VideoFrame'),
      },
      audio: {
        AudioEncoder: probeCtor('AudioEncoder'),
        AudioDecoder: probeCtor('AudioDecoder'),
        AudioData: probeCtor('AudioData'),
      },
      workers: {
        Worker: probeCtor('Worker'),
        OffscreenCanvas: probeCtor('OffscreenCanvas'),
      },
      media: probeMedia(),
      isolation,
    };
    App.videoCompressionCapabilities = report;
    try {
      console.log('[VIDEO-BENCH] capability probe', {
        platform: platform.label,
        VideoEncoder: report.video.VideoEncoder.status,
        AudioEncoder: report.audio.AudioEncoder.status,
        isolated: isolation.crossOriginIsolated.status,
        sab: isolation.SharedArrayBuffer.status,
      });
    } catch (_) {}
    return report;
  }

  async function benchmarkWebCodecsAvailability() {
    const caps = probeVideoCompressionCapabilities();
    const configs = await probeWebCodecsVideoConfigs();
    const encoderOn = caps.video.VideoEncoder.status === STATUS.SUPPORTED;
    return {
      supported: encoderOn,
      configSupport: configs,
      fullTranscodeAvailable: false,
      blockedReason: 'no-demux-mux',
      VideoEncoder: caps.video.VideoEncoder.status,
      VideoDecoder: caps.video.VideoDecoder.status,
      AudioEncoder: caps.audio.AudioEncoder.status,
      AudioDecoder: caps.audio.AudioDecoder.status,
    };
  }

  App.probeVideoCompressionCapabilities = probeVideoCompressionCapabilities;
  App.probeWebCodecsVideoConfigs = probeWebCodecsVideoConfigs;
  App.benchmarkWebCodecsAvailability = benchmarkWebCodecsAvailability;
  App.computeVideoBenchmarkGeometry = computeVideoBenchmarkGeometry;
  App.VIDEO_COMPRESSION_CAPABILITY_STATUS = STATUS;
  App.VIDEO_BENCH_TARGET = {
    shortEdge: TARGET_SHORT_EDGE,
    longEdge: TARGET_LONG_EDGE,
  };
  if (!App.videoCompressionCapabilities) {
    App.videoCompressionCapabilities = null;
  }

  console.log('[VIDEO-BENCH] capability probe module loaded (inert until called)');
})(typeof window !== 'undefined' ? window : globalThis);
