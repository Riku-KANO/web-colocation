// Writes schema/config.schema.json from the zod schema (used by editors via the
// `# yaml-language-server: $schema=` comment, by docs and by the Helm chart).
//
//   npm run gen:schema

import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { AppConfigSchema } from '../server/config/schema.ts';

const schema = {
  $id: 'https://github.com/web-colocation/web-colocation/schema/config.schema.json',
  title: 'web-colocation configuration',
  ...z.toJSONSchema(AppConfigSchema, { io: 'input', target: 'draft-2020-12' }),
};
const file = new URL('../schema/config.schema.json', import.meta.url);
writeFileSync(file, JSON.stringify(schema, null, 2) + '\n');
console.log(`wrote ${file.pathname}`);
