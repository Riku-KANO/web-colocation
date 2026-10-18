// Japanese messages. Must provide every key of en.ts (enforced by the type).

import type { MessageKey } from './en.ts';

export const ja: Record<MessageKey, string> = {
  'error.protocol-mismatch': 'ページが古くなっています。再読み込みしてください。',
  'error.not-found': 'そのルームは存在しません。',
  'error.room-full': 'ルームが満員です。',
  'error.passcode-required': 'このルームにはパスコードが必要です。',
  'error.passcode-invalid': 'パスコードが違います。',
  'error.forbidden': 'このルームに入る権限がありません。',
  'error.unauthenticated': 'もう一度サインインしてください。',
  'error.rate-limited': '試行回数が多すぎます。数分待ってからやり直してください。',
  'error.too-many-rooms': 'サーバーのルーム数が上限に達しています。',
  'error.not-allowed': 'このルームでは主催者だけが行える操作です。',
  'error.limit': 'ホワイトボードがいっぱいです。消去してから描いてください。',
  'error.invalid-settings': 'その設定は適用できませんでした。',
  'passcode.prompt': 'ルーム「{room}」のパスコード',
  'toast.joined': '{name} さんが参加しました',
  'toast.left': '{name} さんが退出しました',
  'toast.roomChanged': 'ルームのレイアウトが変わりました。',
  'toast.replace': 'ルームのレイアウトが変わりました。「正面に置く」か合わせ直しをしてください。',
  'toast.xrFailed': 'XR を開始できませんでした: {message}',
  'toast.pointsTooClose': '2 点が近すぎます (10cm 以上離してください)',
  'board.clear': 'ボードを消去',
};
