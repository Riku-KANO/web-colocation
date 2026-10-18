# 実現可能性の検討 (2026-10 時点)

## 結論

**実現可能。ただし「同じ部屋にいる人同士の位置合わせ (コロケーション)」は WebXR 標準では自動化できないため、手動キャリブレーションで共有座標系を作る方式を採る。**

- 「片方が動かすと、もう片方からも動いて見える」部分は、WebSocket で姿勢を中継するだけなので、どのブラウザでも確実に作れる。このリポジトリで動作を確認済み。
- 難しいのは **全員の座標系をそろえること** の方。WebXR には共有アンカーやクラウドアンカーの標準 API が無い。
  - 別々の部屋 (リモート): 各自が自分の机に「テーブル」を置けば足りる。物理的にそろえる必要はない。
  - 同じ部屋 (コロケーション): 全員が **同じ物理的な 2 点をタッチ** して座標系を合わせる。ブラウザに依存せず使える方法はこれしかない。
- ペン・ホワイトボード・アバター・音声を備えた MR 会議アプリは、この土台の延長で作れる。音声は WebRTC で別途追加する。
- Android XR は、まず **Chrome on Android XR で同じ Web アプリを動かす** のが最短ルート。ネイティブアプリと混在させる場合も、同じ JSON プロトコルを話すクライアントを書けば同じルームに参加できるように設計してある。

## プラットフォーム別の対応状況

| 機能 | Quest Browser | Chrome on Android XR | Vision Pro Safari | 本プロトタイプでの使い方 |
|---|---|---|---|---|
| `immersive-ar` (パススルー) | ○ | ○ | × (VR のみ) | AR モード。非対応端末では VR モード |
| `immersive-vr` | ○ | ○ (と思われる) | ○ | VR モード |
| ハンドトラッキング | ○ | ○ (既定の入力) | △ (`transient-pointer` で操作。手の姿勢は取れるが、手からイベントは来ない) | ピンチで掴む・描く |
| `anchors` | ○ | ○ | × | キャリブ結果をトラッキング補正に追従させる |
| 永続アンカー | ○ (1 サイト 8 個まで) | 未確認 | × | 未使用 (今後の拡張候補) |
| `hit-test` | ○ | ○ | × | 未使用 (タッチ方式で代替) |
| DOM オーバーレイ | × (AR では不可という報告) | 未確認 | × | 使わない。XR 内 UI は 3D パネルで作る |
| カメラ画像 (`camera-access`) | × | 未確認 | × | 使わない (マーカー認識が使えない理由) |
| 共有アンカー / コロケーション | 実験機能のみ (下記) | × | × | 手動 2 点キャリブで代替 |

Android XR の Chrome では、WebXR を使うたびにドメインごとの「3D マッピング / カメラトラッキング」の権限許可が必要になる。

### コロケーション関連の動き

- **Meta Quest Browser v39 以降**に、実験的な `"shared"` 機能 (`XRSharedReferenceSpace`) がある。内部は Shared Spatial Anchors。
  - `chrome://flags` から有効にする必要があり、Quest 専用。
  - 本番では使えないが、将来 `SharedFrame` の 1 つの実装として差し込める。
- **Immersive Web CG** では「ローカル共有空間」の提案 (proposals#82) が出ているだけで、標準化の作業には入っていない。
- **ネイティブ Android XR (Jetpack XR / ARCore)** の状況:
  - 使えるのはアンカーのローカル永続化と、QR / マーカーのトラッキングまで。
  - クラウドアンカーやコロケーション API は無い。
  - Google 公式の「複数人で共有空間を作る」推奨手法は見当たらなかった。
- **Google XR Blocks** は three.js ベースで Android XR 向けの WebXR フレームワーク。
  - netblocks アドオンでアバター・オブジェクト同期ができる。
  - 物理的な位置合わせは自前で作る必要がある。
  - 本実装と同じ three.js r186 系なので、将来乗り換えたり併用したりできる。

## 採用した方針と理由

| 論点 | 採用 | 主な代替案と見送った理由 |
|---|---|---|
| 座標合わせ | 手動キャリブ (1 点 / 2 点) + XRAnchor | マーカー: Quest で WebXR からカメラ画像を取れない。共有アンカー: 標準が無い |
| 通信 | WebSocket 中継 + サーバーにルーム状態 | WebRTC P2P: NAT 越えとシグナリングが必要で、途中参加時の状態同期も自前になる。少人数の会議なら WebSocket の遅延で十分 |
| 競合解決 | 所有権 (先着ロック) + 楽観的グラブ | CRDT: 姿勢のように「最後に掴んだ人が正しい」データには過剰。ホワイトボード文書が複雑になったら Yjs を検討 |
| 3D エンジン | three.js r186 | Babylon.js も有力。XR Blocks / Needle と同じ three.js 系にそろえ、Android XR 向けの資産を流用しやすくした |
| XR 内 UI | 手首パネル (CanvasTexture) | DOM オーバーレイはヘッドセットで使えない |
| 開発・テスト | Meta IWER エミュレータを `?emulate=quest3` で組み込み | 実機がなくても XR の入力経路を自動テストできる |

## リスクと限界

- **2 点キャリブの精度**は、人がタッチする精度 (数 mm〜1 cm) とトラッキングのドリフトで決まる。
  - 2 点の間隔を広く取る (1 m 以上) ほど、回転方向の誤差が小さくなる。
  - 長い会議では再キャリブが必要になることがある。XRAnchor で再ローカライズには追従する。
- **local-floor の床の高さ**は端末ごとの推定値。2 点キャリブでは、タッチした点の高さをそのまま天板の高さとして使うので影響しない。
- **Vision Pro は AR 非対応**なので、VR 空間の参加者になる (リモート参加としては問題ない)。
- 音声・認証・永続化は未実装 (→ [architecture.md](architecture.md) のロードマップ)。

## 主な情報源

- Android XR WebXR: https://developer.android.com/develop/xr/web
- Quest WebXR MR 機能: https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/
- Quest 実験的共有空間: https://github.com/cabanier/shared-spaces / https://www.uploadvr.com/quest-web-browser-experimental-colocation-webxr/
- WebXR Anchors (永続アンカー): https://immersive-web.github.io/anchors/
- ローカル共有空間の提案: https://github.com/immersive-web/proposals/issues/82
- Vision Pro の WebXR: https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/ / https://developer.apple.com/forums/thread/826845
- Jetpack XR アンカー: https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/anchors
- XR Blocks: https://github.com/google/xrblocks
- IWER: https://github.com/meta-quest/immersive-web-emulation-runtime

一部 (Android XR の plane-detection・DOM オーバーレイ・永続アンカー、Quest の light-estimation など) は公式資料で確認できなかった。実機で `navigator.xr` の対応状況を確かめる必要がある。
