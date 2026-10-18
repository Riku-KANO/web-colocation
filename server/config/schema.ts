// Configuration file schema (YAML / JSON). This is the single source of truth for what an
// operator can configure; `npm run gen:schema` exports it as JSON Schema for editors, docs and
// the Helm chart's values.schema.json.
//
// Units: meters and DEGREES in config files (they are converted to radians when resolved).

import { z } from 'zod';

const finite = () => z.number().finite();
const range = (min: number, max: number) => finite().min(min).max(max);

export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour');
/** Identifiers used for templates, boards, tables and objects. */
export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, 'expected [a-zA-Z0-9._-], max 64 chars');
/** Room ids that are predefined in the config (they appear in URLs). */
export const RoomIdSchema = IdSchema;
export const LocalizedSchema = z.union([
  z.string().max(200),
  z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'expected a language code like "en" or "ja"'), z.string().max(200)),
]);
const Vec3Schema = z.tuple([range(-100, 100), range(-100, 100), range(-100, 100)]);
const Deg = () => range(-360, 360);

export const AnchorSchema = z.strictObject({
  kind: z.enum(['table', 'floor']).default('table'),
  floorOffset: range(0, 3).default(0.72).describe('Height of the shared origin above the floor. Use the main table height for \'table\'.'),
});

export const EnvironmentSchema = z.strictObject({
  background: ColorSchema.default('#dfe6ee'),
  floor: z.enum(['grid', 'plain', 'none']).default('grid'),
  floorColor: ColorSchema.default('#d4d9df'),
  light: range(0, 5).default(1),
});

export const TableSchema = z.strictObject({
  id: IdSchema,
  shape: z.enum(['rect', 'round']).default('rect'),
  width: range(0.2, 20),
  depth: range(0.2, 20).optional(),
  height: range(0.3, 1.5).default(0.72),
  color: ColorSchema.default('#b08d6a'),
  x: range(-50, 50).default(0),
  z: range(-50, 50).default(0),
  yaw: Deg().default(0),
});

export const SeatSchema = z.strictObject({
  x: range(-50, 50),
  z: range(-50, 50),
  yaw: Deg().optional().describe('Facing direction in degrees (0 = looking towards -Z). Defaults to facing `lookAt` or the origin.'),
  lookAt: z.tuple([range(-50, 50), range(-50, 50)]).optional(),
});

export const SeatsSchema = z.union([
  z.array(SeatSchema).min(1).max(64),
  z.strictObject({
    auto: z.strictObject({
      count: z.int().min(1).max(64),
      radius: range(0.3, 20),
      startAngle: Deg().default(0).describe('Angle of seat 0 in degrees, measured from +Z towards +X.'),
    }),
  }),
]);

export const BoardSchema = z.strictObject({
  id: IdSchema,
  x: range(-50, 50),
  y: range(-10, 10),
  z: range(-50, 50),
  yaw: Deg().default(0).describe('Degrees; 0 means the drawing surface faces +Z.'),
  width: range(0.2, 10).default(1.2),
  height: range(0.2, 10).default(0.8),
  background: ColorSchema.default('#fbfbf8'),
});

export const ModelSchema = z.strictObject({
  src: z
    .string()
    .max(500)
    .refine((s) => s.startsWith('/room-assets/') || s.startsWith('https://'), 'must start with /room-assets/ or https://'),
  scale: range(0.001, 100).default(1),
  grabRadius: range(0.01, 5).optional(),
});

export const ObjectSchema = z
  .strictObject({
    id: IdSchema,
    kind: z.enum(['cube', 'sphere', 'cone', 'torus', 'pen', 'model']),
    color: ColorSchema.default('#9aa3ad'),
    position: Vec3Schema,
    rotation: z.tuple([Deg(), Deg(), Deg()]).default([0, 0, 0]).describe('Euler angles in degrees (XYZ order).'),
    scale: range(0.01, 100).optional(),
    model: ModelSchema.optional(),
  })
  .refine((o) => (o.kind === 'model') === (o.model !== undefined), {
    message: '`model` is required for kind "model" and only allowed there',
  });

const PermissionSchema = z.enum(['everyone', 'hosts']);

export const RulesSchema = z.strictObject({
  maxParticipants: z.int().min(1).max(256).optional(),
  voice: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  permissions: z
    .strictObject({
      clearBoard: PermissionSchema.optional(),
      resetObjects: PermissionSchema.optional(),
      editSettings: PermissionSchema.optional(),
    })
    .optional(),
});

export const TemplateSchema = z.strictObject({
  id: IdSchema,
  extends: IdSchema.optional().describe('Inherit everything from another template, then override the fields given here.'),
  title: LocalizedSchema.optional(),
  anchor: AnchorSchema.optional(),
  environment: EnvironmentSchema.partial().optional(),
  tables: z.array(TableSchema).max(32).optional(),
  seats: SeatsSchema.optional(),
  boards: z.array(BoardSchema).max(16).optional(),
  objects: z.array(ObjectSchema).max(128).optional().describe('Replaces the inherited objects.'),

  addObjects: z.array(ObjectSchema).max(128).optional().describe('Appended to the inherited objects.'),
  rules: RulesSchema.optional(),
});

/** scrypt$<N>$<r>$<p>$<salt b64>$<hash b64> — generate with `npm run hash-passcode`. */
export const PasscodeHashSchema = z.string().regex(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, 'expected a hash from `npm run hash-passcode`');

export const RoomDefinitionSchema = z.strictObject({
  id: RoomIdSchema.describe('Room id used in URLs (?room=...).'),
  title: LocalizedSchema.optional().describe('Room title. A string or { en: ..., ja: ... }.'),
  template: IdSchema.default('standard').describe('Template id (built-in: standard, round-table, workshop, presentation).'),
  overrides: z
    .strictObject({
      environment: EnvironmentSchema.partial().optional(),
      rules: RulesSchema.optional(),
    })
    .optional(),
  hosts: z.array(z.string().max(254)).max(256).default([]).describe('Emails of people who are hosts of this room (requires trusted-headers auth).'),
  access: z
    .strictObject({
      allowedDomains: z.array(z.string().max(253)).default([]),
      allowedUsers: z.array(z.string().max(254)).default([]),
      allowedGroups: z.array(z.string().max(256)).default([]),
    })
    .optional(),
  passcodeHash: PasscodeHashSchema.optional().describe('Hash from `npm run hash-passcode`. Overrides passcodes set by hosts in the app.'),
  unlisted: z.boolean().default(false).describe('Hide the room from the lobby list (people can still join by id).'),
});

export const IceServerSchema = z.strictObject({
  urls: z.union([z.string().max(500), z.array(z.string().max(500)).min(1).max(10)]),
  username: z.string().max(256).optional(),
  credential: z.string().max(256).optional(),
});

export const AppConfigSchema = z.strictObject({
  server: z
    .strictObject({
      publicUrl: z.url().optional().describe('Public URL (e.g. https://xr.example.com). Its origin is always allowed for WebSockets.'),

      allowedOrigins: z.array(z.string().max(500)).default([]).describe('Extra allowed Origins for WebSocket connections. Same-host origins are always allowed.'),
      maxRooms: z.int().min(1).max(100000).default(500).describe('Maximum number of rooms held in memory.'),
      trustForwardedFor: z.boolean().default(false).describe('Trust X-Forwarded-For for rate limiting (only behind a proxy that overwrites it).'),

      allowServerOverride: z.boolean().default(false).describe('Allow the `?server=` URL parameter to point the client at another sync server.'),

      csp: z.enum(['off', 'report-only', 'enforce']).default('report-only').describe('Content-Security-Policy for the app page. Start with report-only, then enforce.'),
    })
    .prefault({}),
  auth: z
    .strictObject({
      mode: z.enum(['none', 'trusted-headers']).default('none').describe('none: anyone who can reach the app may join (rooms can still have passcodes). trusted-headers: identity comes from an authenticating proxy such as oauth2-proxy.'),
      preset: z.enum(['oauth2-proxy', 'custom']).default('oauth2-proxy').describe('Which identity headers to read. custom uses auth.headers.'),
      headers: z
        .strictObject({
          user: z.string().max(100).optional(),
          email: z.string().max(100).optional(),
          groups: z.string().max(100).optional(),
          name: z.string().max(100).optional(),
        })
        .default({}),
      allowDisplayNameOverride: z.boolean().default(false).describe('Let SSO users change the display name shown to others.'),

      admins: z.array(z.string().max(254)).default([]).describe('Emails that are hosts in every room.'),

      allowNonLoopback: z.boolean().default(false).describe('Allow trusted-headers mode while listening on a non-loopback address (unsafe).'),
    })
    .prefault({}),
  branding: z
    .strictObject({
      productName: LocalizedSchema.default('WebXR Colocation').describe('Name shown in the lobby. A string or { en: ..., ja: ... }.'),
      logo: z.string().max(500).optional().describe('Logo URL, e.g. /room-assets/logo.svg or an https URL.'),
      accentColor: ColorSchema.default('#2f80ed').describe('Accent colour of buttons and highlights.'),
      lobbyMessage: LocalizedSchema.optional().describe('Text under the product name in the lobby.'),
    })
    .prefault({}),
  i18n: z
    .strictObject({ defaultLanguage: z.enum(['en', 'ja']).default('en').describe('UI language when the browser language is not supported.') })
    .prefault({}),
  xr: z
    .strictObject({
      inputProfilesPath: z.string().max(500).optional().describe('Base URL of the WebXR input profiles (controller / hand models). Defaults to jsDelivr.'),
    })
    .prefault({}),
  voice: z
    .strictObject({
      enabled: z.boolean().default(true).describe('Offer voice chat (WebRTC, peer to peer).'),
      iceServers: z.array(IceServerSchema).max(10).default([{ urls: 'stun:stun.l.google.com:19302' }]).describe('STUN/TURN servers with static credentials.'),
      turn: z
        .strictObject({
          urls: z.array(z.string().max(500)).min(1).max(10).describe('TURN URLs, e.g. turn:turn.example.com:3478?transport=udp.'),
          secretEnv: z.string().max(100).default('TURN_SECRET').describe('Environment variable holding the TURN REST shared secret (coturn static-auth-secret).'),
          ttlSeconds: z.int().min(60).max(86400).default(3600).describe('Lifetime of issued TURN credentials (refreshed automatically).'),
        })
        .optional(),
    })
    .prefault({}),
  storage: z
    .strictObject({
      driver: z.enum(['memory', 'file']).default('memory').describe('memory: state is lost on restart. file: one JSON file per room under storage.dir.'),
      dir: z.string().max(500).default('/data').describe('Directory for the file driver (a persistent volume).'),
    })
    .prefault({}),
  assets: z
    .strictObject({
      dir: z.string().max(500).optional().describe('Directory served at /room-assets/ (logos, GLB models...).'),

      allowedOrigins: z.array(z.string().max(500)).default([]).describe('https origins models may be loaded from.'),
      maxModelBytes: z.int().min(1024).max(512 * 1024 * 1024).default(25 * 1024 * 1024).describe('Largest glTF/GLB model (bytes) served and downloaded.'),
    })
    .prefault({}),
  rooms: z
    .strictObject({
      allowAdhoc: z.boolean().default(true).describe('Allow joining any room name (created on demand from adhocTemplate).'),
      adhocTemplate: IdSchema.default('standard').describe('Template for rooms created on demand.'),
      adhocTtlHours: z.int().min(1).max(24 * 365).default(24 * 7).describe('Delete stored state of ad-hoc rooms unused for this long.'),
      list: z.array(RoomDefinitionSchema).max(1000).default([]).describe('Predefined rooms shown in the lobby.'),
    })
    .prefault({}),
  templates: z.array(TemplateSchema).max(200).default([]).describe('Custom room templates (in addition to the built-in ones).'),
});

export type AppConfig = z.output<typeof AppConfigSchema>;
export type AppConfigInput = z.input<typeof AppConfigSchema>;
export type TemplateInput = z.input<typeof TemplateSchema>;
export type Template = z.output<typeof TemplateSchema>;
export type RoomDefinition = z.output<typeof RoomDefinitionSchema>;
export type RulesInput = z.output<typeof RulesSchema>;
