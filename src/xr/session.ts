// Starts WebXR sessions, plus an emulator (Meta IWER) for trying things without a headset.

import type { WebGLRenderer } from 'three';

export type XRMode = 'immersive-ar' | 'immersive-vr';

export interface XRSupport {
  ar: boolean;
  vr: boolean;
}

export async function detectXRSupport(): Promise<XRSupport> {
  const xr = navigator.xr;
  if (!xr) return { ar: false, vr: false };
  const [ar, vr] = await Promise.all([
    xr.isSessionSupported('immersive-ar').catch(() => false),
    xr.isSessionSupported('immersive-vr').catch(() => false),
  ]);
  return { ar, vr };
}

/**
 * Require only what every device supports and request the rest as optional.
 *   local-floor   : reference space that knows the floor height (falls back to local)
 *   anchors       : keeps the calibration in place when tracking corrects itself (Quest / Android XR)
 *   hand-tracking : pinch without controllers (Quest / Android XR / Vision Pro)
 */
export async function startXR(renderer: WebGLRenderer, mode: XRMode): Promise<XRSession> {
  const session = await navigator.xr!.requestSession(mode, {
    optionalFeatures: ['local-floor', 'anchors', 'hand-tracking'],
  });
  let refType: XRReferenceSpaceType = 'local-floor';
  try {
    await session.requestReferenceSpace('local-floor');
  } catch {
    refType = 'local';
  }
  renderer.xr.setReferenceSpaceType(refType);
  await renderer.xr.setSession(session);
  return session;
}

/** With `?emulate=quest3`, emulates WebXR using Meta's IWER (for development and automated tests). */
export async function installEmulatorIfRequested(): Promise<unknown | null> {
  const which = new URLSearchParams(location.search).get('emulate');
  if (!which) return null;
  const iwer = await import('iwer');
  const configs: Record<string, typeof iwer.metaQuest3> = {
    quest3: iwer.metaQuest3,
    quest2: iwer.metaQuest2,
    questpro: iwer.metaQuestPro,
  };
  const device = new iwer.XRDevice(configs[which] ?? iwer.metaQuest3);
  device.installRuntime({ forceInstall: true });
  device.stereoEnabled = false;
  // Eye height of a seated person.
  device.position.set(0, 1.2, 0);
  (window as unknown as { __xrDevice: unknown }).__xrDevice = device;
  console.info('[colo] IWER emulator installed:', device.name);
  return device;
}
