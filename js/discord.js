/* Expedition Board — Discord forum posts (GM only).

   Every expedition the GM schedules becomes a post in a Discord *forum* channel through one
   webhook: the post is a card (an embed) and its own thread. A forum is what makes that one call —
   in a plain text channel a webhook cannot start a thread.

   What a webhook can and cannot do decides the shape of this file:
     - Creating the post sets the thread name and its tags. Neither can be changed afterwards by a
       webhook (Edit Webhook Message takes content/embeds only). So the thread is named for the
       expedition's title alone — a date in it would go stale on the first reschedule — and the
       Cancelled tag, or a Sponsored tag added later, is swapped by hand. The board says so.
     - The card can be edited for ever, so it always shows the current date, party and status.
     - A plain message posted into the thread is how a change *notifies* — Discord pings the people
       following that post. Edits to the card notify nobody. changeNote() decides which is which.

   The webhook URL is a bearer secret (anyone holding it can post as the board), so it is stored in
   secrets/discord, which the rules let only a GM read. Like the calendar write, this runs only in
   the GM's browser, at the moment of a click: the board is the roster of record and a Discord
   failure never undoes a scheduling.

   Times go out as Discord timestamps (<t:unix:F>), which every reader sees in their own zone. */
(function () {
  'use strict';
  const KS = window.KS, U = KS.util;
  const $ = s => document.querySelector(s);
  const HOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)$/;
  const CRIMSON = 0x9b2335, GOLD = 0xb8862b, ASH = 0x6b6b6b;
  let cfg = null, loaded = false, loading = null, busyNow = false;

  const boardUrl = () => location.origin + location.pathname;
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const snowflake = v => /^\d{15,21}$/.test(String(v || '').trim());
  // A pasted URL picks up trailing whitespace, sometimes percent-encoded; the Foundry relay was
  // once refused "Invalid Webhook Token" over exactly that.
  const cleanUrl = u => String(u || '').trim().replace(/(?:%20|%09|%0A|%0D)+$/i, '').replace(/\/+$/, '');
  const ready = () => !!(cfg && cfg.webhook);
  const threadUrl = p => cfg && cfg.guildId && p && p.threadId ? `https://discord.com/channels/${cfg.guildId}/${p.threadId}` : null;

  // When the window opens, as unix seconds, for <t:…> stamps.
  function stamp(sess) {
    const d = U.parseKey(sess.date); d.setHours(U.blockOf(sess.block).from, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  function load() {
    if (loaded) return Promise.resolve(cfg);
    if (!loading) {
      const A = KS.adapter();
      loading = (A && A.getDiscord ? A.getDiscord() : Promise.resolve(null))
        .catch(err => { console.warn('Discord settings unavailable:', err && err.message); return null; })
        .then(c => { cfg = c; loaded = true; loading = null; KS.renderDiscord(); if (KS.rerender) KS.rerender(); return cfg; });
    }
    return loading;
  }
  KS.discordReady = () => KS.isGM() && ready();

  // ---------------------------------------------------------------- the card
  function card(sess) {
    const off = sess.status === 'cancelled', party = sess.party || [], at = stamp(sess), b = U.blockOf(sess.block);
    const fields = [
      { name: 'When', value: `${b.label} · <t:${at}:F> (<t:${at}:R>)` },
      { name: 'Where', value: clip(sess.region || '—', 1024), inline: true },
      { name: 'GM', value: clip(sess.gm || '—', 1024), inline: true },
      { name: 'Levels', value: `${sess.minLevel}–${sess.maxLevel}`, inline: true },
      { name: `Party · ${party.length} of ${sess.seats}${sess.locked ? ' · locked' : ''}`,
        value: party.length ? clip(party.map(e => `${e.name} (${e.level})${e.owner ? ` — ${e.owner}` : ''}`).join('\n'), 1024) : 'No one seated yet.' },
    ];
    if (sess.sponsor) fields.push({ name: 'Sponsored', value: clip(`Backed by ${sess.sponsor}`, 1024) });
    return {
      title: clip((off ? 'CANCELLED — ' : '') + sess.title, 256),
      url: boardUrl(),
      description: off ? 'This expedition will not run.' : (sess.notes ? clip(sess.notes, 4000) : undefined),
      color: off ? ASH : sess.sponsor ? GOLD : CRIMSON,
      fields,
      footer: { text: 'Expedition Board · take a seat or see changes on the board' },
    };
  }

  // The one line posted into the thread when an expedition changes — the only thing that pings
  // the people following it. null means "edit the card quietly".
  //   before / after: session objects (date, block, region, gm, seats, minLevel, maxLevel, notes,
  //   sponsor, locked, status, party[{name, level, owner}]). stamp(sess) gives <t:…> seconds.
  function changeNote(before, after) {
    // Cancelled: always tell people.
    if (after.status === 'cancelled' && before.status !== 'cancelled')
      return `❌ **Cancelled.** This expedition will not run.`;

    // New date or time window: always tell people, in their own time zone.
    if (before.date !== after.date || before.block !== after.block)
      return `🕰️ **Moved** to <t:${stamp(after)}:F> (<t:${stamp(after)}:R>).`;

    // Roster locked or unlocked.
    if (before.locked !== after.locked)
      return after.locked ? `🔒 **Roster locked.** No more seats will change.` : `🔓 **Roster reopened.** Seats can change again.`;

    // You took someone off the expedition.
    if ((after.party || []).length < (before.party || []).length)
      return `🪑 **A seat opened up.** Take it on the board.`;

    // Anything else (notes, title, level band): update the card quietly.
    return null;
  }

  // ------------------------------------------------------------------ calls
  async function hook(method, path, body) {
    const res = await fetch(cfg.webhook + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(res.status, json));
    return json;
  }

  // A new forum post for a scheduled expedition. Tags are chosen now, because now is the only time.
  KS.discordPost = async function (sess) {
    const A = KS.adapter();
    await load();
    if (!KS.discordReady() || !sess || !sess.id || sess.status === 'cancelled' || !sess.date) return;
    if (sess.discordPost) return KS.discordUpdate(sess, sess);
    try {
      const t = cfg.tags || {};
      const tags = [t.scheduled, sess.sponsor ? t.sponsored : null].filter(snowflake);
      const msg = await hook('POST', '?wait=true', {
        thread_name: clip(sess.title, 100),
        embeds: [card(sess)],
        applied_tags: tags.length ? tags : undefined,
        allowed_mentions: { parse: [] },
      });
      await A.setDiscordPost(sess.id, { messageId: msg.id, threadId: msg.channel_id });
      KS.toast(`“${sess.title}” is posted in Discord.`, 'ok');
    } catch (err) {
      KS.toast(`On the board, but not in Discord: ${err.message || 'the post failed'}. Use “Post to Discord” on the expedition to try again.`, 'no');
    }
  };

  // The card follows the board; a thread note goes out only when changeNote() says it should.
  KS.discordUpdate = async function (before, after) {
    await load();
    const p = after && after.discordPost;
    if (!KS.discordReady() || !p || !p.messageId) return;
    const q = `?thread_id=${encodeURIComponent(p.threadId)}`;
    try {
      await hook('PATCH', `/messages/${encodeURIComponent(p.messageId)}${q}`, { embeds: [card(after)], allowed_mentions: { parse: [] } });
      const note = changeNote(before, after);
      if (note) await hook('POST', q, { content: clip(note, 2000), allowed_mentions: { parse: [] } });
      // The two things a webhook cannot do: say which tag to change, and link straight to it.
      const link = threadUrl(p), where = link ? ' (link copied)' : '';
      const swap = after.status === 'cancelled' && before.status !== 'cancelled' ? 'Cancelled'
        : after.sponsor && !before.sponsor ? 'Sponsored' : null;
      if (swap) {
        if (link && navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
        KS.toast(`Discord updated. Add the ${swap} tag to the post by hand${where} — a webhook cannot change tags.`, 'hint');
      }
    } catch (err) {
      KS.toast(`On the board, but Discord was not updated: ${err.message || 'the edit failed'}.`, 'no');
    }
  };

  // ------------------------------------------------------------------ panel
  KS.renderDiscord = function () {
    const el = $('#discord'); if (!el) return;
    if (!KS.state() || !KS.isGM()) { el.innerHTML = ''; return; }
    if (!loaded) { el.innerHTML = '<span class="label">Discord</span>'; load(); return; }
    const c = cfg || {}, t = c.tags || {}, local = !KS.adapter().getCalendarToken;
    el.innerHTML = `
      <div class="gcal__head">
        <span class="label">Discord</span>
        <span class="gcal__state${ready() ? ' gcal__state--on' : ''}">${ready() ? `Posting as ${U.esc(c.name || 'the webhook')}` : 'Not set up'}</span>
      </div>
      <details class="gcal__break"${ready() ? '' : ' open'}>
        <summary>Webhook and forum tags</summary>
        <form id="discord-form" class="discord__form" autocomplete="off">
          <label class="field"><span>Webhook URL</span><input name="webhook" type="password" spellcheck="false" placeholder="${ready() ? 'Saved — paste a new one to replace it' : 'https://discord.com/api/webhooks/…'}"></label>
          <label class="field"><span>Scheduled tag ID</span><input name="scheduled" inputmode="numeric" value="${U.esc(t.scheduled || '')}"></label>
          <label class="field"><span>Sponsored tag ID</span><input name="sponsored" inputmode="numeric" value="${U.esc(t.sponsored || '')}"></label>
          <label class="field"><span>Cancelled tag ID</span><input name="cancelled" inputmode="numeric" value="${U.esc(t.cancelled || '')}"></label>
          <div class="row"><button type="submit" class="btn btn--sm"${busyNow ? ' disabled' : ''}>${busyNow ? 'Checking…' : 'Save'}</button></div>
        </form>
        <p class="hint hint--inline">Tag IDs: turn on Developer Mode (User Settings → Advanced), then right-click the tag in the forum → Copy ID. Tags are optional — without them the post goes up untagged.</p>
      </details>
      <p class="hint hint--inline">${local
        ? 'Sample board: the webhook is kept in this browser only — and it posts for real.'
        : 'Only GMs can read the webhook. Scheduling posts a card and thread; edits update the card.'}</p>`;
    $('#discord-form').addEventListener('submit', onSave);
  };

  async function onSave(e) {
    e.preventDefault();
    const A = KS.adapter(), v = Object.fromEntries(new FormData(e.target).entries());
    const url = cleanUrl(v.webhook) || (cfg && cfg.webhook) || '';
    const tags = {};
    for (const k of ['scheduled', 'sponsored', 'cancelled']) {
      const id = String(v[k] || '').trim();
      if (id && !snowflake(id)) { KS.toast(`The ${k} tag ID should be a long number — Copy ID gives exactly that.`, 'no'); return; }
      if (id) tags[k] = id;
    }
    if (!HOOK.test(url)) { KS.toast('That is not a Discord webhook URL — it should look like https://discord.com/api/webhooks/<id>/<token>.', 'no'); return; }
    busyNow = true; KS.renderDiscord();
    try {
      // GET on a webhook URL returns the webhook itself: proof the token works, and the server id
      // the board needs to link straight to a thread.
      const res = await fetch(url);
      const w = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(explain(res.status, w));
      cfg = { webhook: url, guildId: w.guild_id || null, channelId: w.channel_id || null, name: w.name || '', tags };
      await A.setDiscord(cfg);
      KS.toast(`Saved — expeditions you schedule will post as “${cfg.name || 'the webhook'}”.`, 'ok');
    } catch (err) {
      KS.toast(err.message || 'Could not save the Discord settings.', 'no');
    } finally {
      busyNow = false; KS.renderDiscord(); if (KS.rerender) KS.rerender();
    }
  }

  function explain(code, json) {
    const msg = (json && json.message) || '';
    if (code === 401 || code === 404) return 'Discord does not recognise that webhook — it may have been deleted. Make a new one on the forum and paste it in.';
    if (code === 429) return 'Discord is rate-limiting the board — wait a minute and try again.';
    if (code === 400 && /tag/i.test(JSON.stringify(json))) return 'Discord refused a tag ID — check the tag IDs in the Discord settings.';
    return msg ? `Discord: ${msg}` : `Discord returned ${code}.`;
  }

  if (KS.state && KS.state()) KS.renderDiscord();
})();
