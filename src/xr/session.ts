// WebXR セッションの開始と、ヘッドセット無しで試すためのエミュレータ (Meta IWER)。

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
 * どの端末でも使える機能だけを必須にし、あとは optional で要求する。
 *   local-floor   : 床の高さが分かる参照空間 (無ければ local にフォールバック)
 *   anchors       : キャリブレーション結果をトラッキング補正に追従させる (Quest / Android XR)
 *   hand-tracking : コントローラー無しでピンチ操作 (Quest / Android XR / Vision Pro)
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

/** `?emulate=quest3` のとき、Meta の IWER で WebXR をエミュレートする (開発・自動テスト用)。 */
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
  // 座った人の目線の高さ
  device.position.set(0, 1.2, 0);
  (window as unknown as { __xrDevice: unknown }).__xrDevice = device;
  console.info('[colo] IWER emulator installed:', device.name);
  return device;
}
