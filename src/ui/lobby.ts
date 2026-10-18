// Lobby: branding, the signed-in user, the room list from the server, ad-hoc rooms, passcodes,
// colour and language. URL parameters pre-fill it; `autojoin=1` skips it.

import type { ClientConfig, LobbyRoom } from '../../shared/clientConfig.ts';
import { LANGUAGES, getLanguage, setLanguage, t, tl, type Lang } from '../i18n/index.ts';
import { h, replaceChildren, setAccentColor } from './dom.ts';

export interface JoinOptions {
  name: string;
  room: string;
  space: string;
  color: string;
}

export const PALETTE = ['#e4572e', '#4c8bf5', '#3fb27f', '#f2a541', '#9b5de5', '#f15bb5', '#00bbf9', '#2b2d42'];
const STORAGE_KEY = 'colo.profile';
const LANG_LABEL: Record<Lang, string> = { en: 'English', ja: '日本語' };

function loadProfile(): Partial<JoinOptions> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<JoinOptions>;
  } catch {
    return {};
  }
}

function saveProfile(p: JoinOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // private mode etc.
  }
}

/** Remember a passcode for this tab so reconnects keep working. */
export function rememberPasscode(room: string, passcode: string): void {
  try {
    sessionStorage.setItem(`colo.passcode.${room}`, passcode);
  } catch {
    // ignore
  }
}

export function showLobby(client: ClientConfig): Promise<JoinOptions> {
  setAccentColor(client.branding.accentColor);
  const params = new URLSearchParams(location.search);
  const saved = loadProfile();
  const identity = client.auth.identity;
  const lockedName = !!identity && !client.auth.allowDisplayNameOverride;
  const initial: JoinOptions = {
    name: (lockedName ? identity.name : null) ?? params.get('name') ?? saved.name ?? identity?.name ?? '',
    room: params.get('room') ?? saved.room ?? client.rooms[0]?.id ?? 'demo',
    space: params.get('space') ?? saved.space ?? '',
    color: params.get('color') ?? saved.color ?? '',
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(initial.color)) initial.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  if (params.get('autojoin') === '1' && initial.name) return Promise.resolve(initial);

  const root = document.getElementById('lobby')!;
  root.hidden = false;
  return new Promise((resolve) => {
    const render = () => {
      const listed = client.rooms;
      const isListed = (id: string) => listed.some((r) => r.id === id);
      let selected = initial.room;
      if (!isListed(selected) && !client.allowAdhoc) selected = listed[0]?.id ?? '';

      const passcodeInput = h('input', { name: 'passcode', type: 'password', maxlength: 128, autocomplete: 'off' });
      const passcodeRow = h('label', {}, t('lobby.passcode'), passcodeInput);
      const adhocInput = h('input', {
        name: 'room',
        maxlength: 64,
        value: isListed(selected) ? '' : selected,
        placeholder: t('lobby.roomName'),
        on: { focus: () => choose(null) },
      });
      const roomButtons = new Map<string, HTMLButtonElement>();

      const choose = (room: LobbyRoom | null) => {
        selected = room ? room.id : adhocInput.value.trim();
        for (const [id, b] of roomButtons) b.classList.toggle('on', id === room?.id);
        passcodeRow.hidden = room ? !room.passcode : true;
        adhocInput.classList.toggle('on', !room);
      };

      const roomList = listed.length
        ? h(
            'div',
            { class: 'rooms' },
            ...listed.map((r) => {
              const b = h(
                'button',
                { type: 'button', class: 'room', on: { click: () => choose(r) } },
                h('b', {}, tl(r.title, r.id)),
                r.passcode ? h('small', {}, `🔒 ${t('lobby.locked')}`) : null,
              );
              roomButtons.set(r.id, b);
              return b;
            }),
          )
        : !client.allowAdhoc
          ? h('p', { class: 'sub' }, t('lobby.noRooms'))
          : null;

      const nameInput = h('input', {
        name: 'name',
        maxlength: 32,
        required: true,
        value: initial.name,
        placeholder: t('lobby.namePlaceholder'),
        readonly: lockedName,
      });
      const spaceInput = h('input', { name: 'space', maxlength: 64, value: initial.space, placeholder: 'office-3F' });
      const swatches = h(
        'div',
        { class: 'swatches' },
        ...PALETTE.map((c) =>
          h('label', { class: 'swatch', vars: { '--c': c } }, h('input', { type: 'radio', name: 'color', value: c, checked: c === initial.color })),
        ),
      );
      const langs = h(
        'div',
        { class: 'langs' },
        ...LANGUAGES.map((l) =>
          h(
            'button',
            {
              type: 'button',
              class: l === getLanguage() ? 'lang on' : 'lang',
              on: {
                click: () => {
                  initial.name = nameInput.value;
                  initial.space = spaceInput.value;
                  initial.room = selected;
                  setLanguage(l, true);
                  render();
                },
              },
            },
            LANG_LABEL[l],
          ),
        ),
      );

      const form = h(
        'form',
        {
          class: 'card',
          on: {
            submit: (e) => {
              e.preventDefault();
              const fd = new FormData(form);
              const opts: JoinOptions = {
                name: nameInput.value.trim(),
                room: selected || adhocInput.value.trim() || 'demo',
                space: spaceInput.value.trim(),
                color: String(fd.get('color') ?? initial.color),
              };
              if (!opts.room) return;
              if (passcodeInput.value) rememberPasscode(opts.room, passcodeInput.value);
              saveProfile(opts);
              root.hidden = true;
              resolve(opts);
            },
          },
        },
        h(
          'header',
          {},
          client.branding.logo ? h('img', { class: 'logo', src: client.branding.logo, alt: '' }) : null,
          h('h1', {}, tl(client.branding.productName, 'WebXR Colocation')),
        ),
        h('p', { class: 'sub' }, tl(client.branding.lobbyMessage, t('lobby.defaultMessage'))),
        identity ? h('p', { class: 'identity' }, t('lobby.signedInAs', { email: identity.email ?? identity.name })) : null,
        h('label', {}, t('lobby.name'), nameInput),
        h('div', { class: 'field' }, h('span', {}, t('lobby.rooms')), roomList, client.allowAdhoc ? h('label', { class: 'adhoc' }, listed.length ? t('lobby.otherRoom') : t('lobby.roomName'), adhocInput) : null),
        passcodeRow,
        h('label', {}, h('span', {}, t('lobby.space'), ' ', h('small', {}, `(${t('lobby.spaceHelp')})`)), spaceInput),
        h('div', { class: 'field' }, h('span', {}, t('lobby.color')), swatches),
        h('div', { class: 'field' }, h('span', {}, t('lobby.language')), langs),
        h('button', { type: 'submit' }, t('lobby.join')),
      );
      replaceChildren(root, form);
      adhocInput.addEventListener('input', () => choose(null));
      choose(listed.find((r) => r.id === selected) ?? null);
      if (!isListed(selected)) adhocInput.value = selected;
    };
    render();
  });
}
