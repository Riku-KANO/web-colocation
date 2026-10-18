// Generates JSON Schemas from the zod config schema:
//   schema/config.schema.json                        — for editors (yaml-language-server) and docs
//   deploy/helm/web-colocation/values.schema.json    — Helm validates `config:` on install/upgrade
//
//   npm run gen:schema

import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { AppConfigSchema } from '../server/config/schema.ts';

const write = (rel: string, data: unknown) => {
  const file = new URL(`../${rel}`, import.meta.url);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`wrote ${rel}`);
};

write('schema/config.schema.json', {
  $id: 'https://github.com/OWNER/web-colocation/schema/config.schema.json',
  title: 'web-colocation configuration',
  ...z.toJSONSchema(AppConfigSchema, { io: 'input', target: 'draft-2020-12' }),
});

// Helm (3.x and 4.x) validates values with draft-07. The chart computes storage/assets/auth, so
// only the user-facing `config` is strictly validated; the other values get basic type checks.
const configSchema = z.toJSONSchema(AppConfigSchema, { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
delete configSchema.$schema;
const values = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../deploy/helm/web-colocation/values.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
})();
const str = { type: 'string' };
const bool = { type: 'boolean' };
const obj = { type: 'object' };
const arr = { type: 'array' };
write('deploy/helm/web-colocation/values.schema.json', {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'web-colocation Helm values',
  type: 'object',
  properties: {
    ...(values.properties as object | undefined),
    image: { type: 'object', properties: { repository: str, tag: str, pullPolicy: { enum: ['Always', 'IfNotPresent', 'Never'] } } },
    config: configSchema,
    existingConfigMap: str,
    logLevel: { enum: ['debug', 'info', 'warn', 'error'] },
    persistence: { type: 'object', properties: { enabled: bool, size: str, storageClass: str, accessModes: arr, existingClaim: str } },
    assets: { type: 'object', properties: { existingClaim: str, configMap: str } },
    turn: { type: 'object', properties: { existingSecret: str, secretKey: str, secret: str } },
    oauth2Proxy: {
      type: 'object',
      properties: {
        enabled: bool,
        provider: str,
        oidcIssuerUrl: str,
        clientId: str,
        existingSecret: str,
        clientSecret: str,
        cookieSecret: { type: 'string', pattern: '^(|.{16}|.{24}|.{32})$' },
        redirectUrl: str,
        emailDomains: arr,
        allowedGroups: arr,
        nativeSidecar: bool,
        extraArgs: arr,
        extraEnv: arr,
      },
    },
    service: { type: 'object', properties: { type: str, port: { type: 'integer' }, annotations: obj } },
    ingress: { type: 'object', properties: { enabled: bool, className: str, annotations: obj, hosts: arr, tls: arr } },
    httpRoute: { type: 'object', properties: { enabled: bool, annotations: obj, parentRefs: arr, hostnames: arr } },
    preStopSleepSeconds: { type: 'integer', minimum: 0 },
    terminationGracePeriodSeconds: { type: 'integer', minimum: 1 },
  },
});
