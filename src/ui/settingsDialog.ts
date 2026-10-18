// Host-only dialog to change the room: title, layout template, rules and passcode.
// The server validates, persists and broadcasts the change to everyone.

import type { ClientConfig } from '../../shared/clientConfig.ts';
import type { PermissionLevel, RoomConfig, RoomSettingsPatch } from '../../shared/roomConfig.ts';
import { t, tl } from '../i18n/index.ts';
import { h } from './dom.ts';

export function openSettingsDialog(room: RoomConfig, client: ClientConfig, apply: (patch: RoomSettingsPatch) => void): void {
  document.querySelector('dialog.settings')?.remove();
  const title = h('input', { name: 'title', maxlength: 80, value: tl(room.title, room.id), required: true });
  const template = h(
    'select',
    { name: 'template' },
    ...client.templates.map((tpl) => h('option', { value: tpl.id, selected: tpl.id === room.template }, tl(tpl.title, tpl.id))),
  );
  const max = h('input', { name: 'max', type: 'number', min: 1, max: 256, value: room.rules.maxParticipants });
  const voice = h('input', { name: 'voice', type: 'checkbox', checked: room.rules.voice.enabled });
  const perm = (name: string, value: PermissionLevel) =>
    h(
      'select',
      { name },
      h('option', { value: 'everyone', selected: value === 'everyone' }, t('settings.everyone')),
      h('option', { value: 'hosts', selected: value === 'hosts' }, t('settings.hosts')),
    );
  const clear = perm('clearBoard', room.rules.permissions.clearBoard);
  const reset = perm('resetObjects', room.rules.permissions.resetObjects);
  const edit = perm('editSettings', room.rules.permissions.editSettings);
  const passMode = h(
    'select',
    { name: 'passMode' },
    h('option', { value: 'keep' }, t('settings.passcodeKeep')),
    h('option', { value: 'set' }, t('settings.passcodeSet')),
    h('option', { value: 'remove' }, t('settings.passcodeRemove')),
  );
  const pass = h('input', { name: 'passcode', type: 'password', maxlength: 128, autocomplete: 'new-password', hidden: true });
  passMode.addEventListener('change', () => (pass.hidden = passMode.value !== 'set'));

  const dialog = h('dialog', { class: 'settings' });
  const form = h(
    'form',
    {
      method: 'dialog',
      on: {
        submit: (e) => {
          if ((e as SubmitEvent).submitter?.getAttribute('value') !== 'apply') return;
          const patch: RoomSettingsPatch = {
            title: title.value.trim(),
            rules: {
              maxParticipants: Number(max.value),
              voice: { enabled: voice.checked },
              permissions: {
                clearBoard: clear.value as PermissionLevel,
                resetObjects: reset.value as PermissionLevel,
                editSettings: edit.value as PermissionLevel,
              },
            },
          };
          if (template.value !== room.template) patch.template = template.value;
          if (passMode.value === 'remove') patch.passcode = null;
          if (passMode.value === 'set' && pass.value) patch.passcode = pass.value;
          apply(patch);
        },
      },
    },
    h('h2', {}, t('settings.title')),
    h('label', {}, t('settings.roomTitle'), title),
    h('label', {}, t('settings.template'), template, h('small', {}, t('settings.templateWarning'))),
    h('label', {}, t('settings.maxParticipants'), max),
    h('label', { class: 'check' }, voice, t('settings.voice')),
    h('label', {}, t('settings.permClear'), clear),
    h('label', {}, t('settings.permReset'), reset),
    h('label', {}, t('settings.permEdit'), edit),
    h('label', {}, t('settings.passcode'), passMode, pass),
    h(
      'div',
      { class: 'actions' },
      h('button', { value: 'cancel', class: 'secondary', formnovalidate: true }, t('settings.cancel')),
      h('button', { value: 'apply' }, t('settings.apply')),
    ),
  );
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
