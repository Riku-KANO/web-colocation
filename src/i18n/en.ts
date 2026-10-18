// English messages — the source of truth for message keys.

export const en = {
  'error.protocol-mismatch': 'This page is out of date. Please reload.',
  'error.not-found': 'That room does not exist.',
  'error.room-full': 'The room is full.',
  'error.passcode-required': 'This room requires a passcode.',
  'error.passcode-invalid': 'Wrong passcode.',
  'error.forbidden': 'You are not allowed to join this room.',
  'error.unauthenticated': 'Please sign in again.',
  'error.rate-limited': 'Too many attempts. Please wait a few minutes.',
  'error.too-many-rooms': 'The server has reached its room limit.',
  'error.not-allowed': 'Only hosts can do that in this room.',
  'error.limit': 'The whiteboard is full. Clear it to keep drawing.',
  'error.invalid-settings': 'Those settings could not be applied.',
  'passcode.prompt': 'Passcode for room "{room}"',
  'toast.joined': '{name} joined',
  'toast.left': '{name} left',
  'toast.roomChanged': 'The room layout changed.',
  'toast.replace': 'The room layout changed — use “Place in front” or calibrate again.',
  'toast.xrFailed': 'Could not start XR: {message}',
  'toast.pointsTooClose': 'The two points are too close (keep them at least 10 cm apart).',
  'board.clear': 'Clear board',
} as const;

export type MessageKey = keyof typeof en;
