// Persistence and business rules for Rope.
// All privacy and admin rules are enforced here, never in the browser.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const randomSecret = () => randomBytes(18).toString('base64url');
const CODE_RE = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Data model
 *  users:  { [id]: { id, name, tokenHash, code, visible, position, createdAt } }
 *  links:  { [pairKey]: { members: [idA, idB], createdAt, nick: { [userId]: string } } }
 *          A link is a contact relation. It is symmetric.
 *  grants: { [`${adminId}>${subjectId}`]: { admin, subject, createdAt } }
 *          A grant is directional: the admin sees the subject regardless of the
 *          subject's visibility toggle, and only the admin can remove the grant.
 */
export class Store {
  constructor(file = null) {
    this.file = file;
    this.users = {};
    this.links = {};
    this.grants = {};
    this.writing = Promise.resolve();
  }

  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.users = data.users ?? {};
      this.links = data.links ?? {};
      this.grants = data.grants ?? {};
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  persist() {
    if (!this.file) return Promise.resolve();
    const json = JSON.stringify({ users: this.users, links: this.links, grants: this.grants });
    const file = this.file;
    const tmp = `${file}.tmp`;
    this.writing = this.writing
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(tmp, json);
        await rename(tmp, file);
      })
      .catch((err) => console.error('persist failed:', err));
    return this.writing;
  }

  // ---------- identity ----------

  register(rawName) {
    const name = String(rawName ?? '').trim();
    if (name.length < 1 || name.length > 40) throw new HttpError(400, 'Name must be 1-40 characters');
    const id = randomUUID();
    const token = randomSecret();
    const user = {
      id,
      name,
      tokenHash: sha256(token),
      code: randomSecret(), // reusable pairing secret, shown only to its owner
      visible: true,
      position: null,
      createdAt: Date.now(),
    };
    this.users[id] = user;
    this.persist();
    return { token, me: this.publicMe(user) };
  }

  userByToken(token) {
    if (!token) return null;
    const h = sha256(token);
    return Object.values(this.users).find((u) => safeEqual(u.tokenHash, h)) ?? null;
  }

  rotateCode(meId) {
    const me = this.requireUser(meId);
    me.code = randomSecret(); // old code stops working; existing contacts are kept
    this.persist();
    return this.publicMe(me);
  }

  // ---------- contacts ----------

  pairKey(a, b) {
    return [a, b].sort().join('|');
  }

  pair(meId, rawCode) {
    const match = CODE_RE.exec(String(rawCode ?? '').trim());
    if (!match) throw new HttpError(400, 'Invalid contact code');
    const [, otherId, secret] = match;
    const other = this.users[otherId];
    if (!other || !safeEqual(other.code, secret)) throw new HttpError(404, 'No user matches that code');
    if (otherId === meId) throw new HttpError(400, 'That is your own code');
    const key = this.pairKey(meId, otherId);
    if (!this.links[key]) {
      this.links[key] = { members: [meId, otherId], createdAt: Date.now(), nick: {} };
      this.persist();
    }
    return this.contactView(meId, otherId);
  }

  setNickname(meId, otherId, rawNick) {
    const link = this.requireLink(meId, otherId);
    const nick = String(rawNick ?? '').trim().slice(0, 40);
    if (nick) link.nick[meId] = nick;
    else delete link.nick[meId];
    this.persist();
    return this.contactView(meId, otherId);
  }

  removeContact(meId, otherId) {
    this.requireLink(meId, otherId);
    // A subject cannot remove a contact while an admin holds admin rights over them.
    if (this.grants[`${otherId}>${meId}`]) {
      throw new HttpError(403, 'An admin has set this. Only they can change it.');
    }
    delete this.grants[`${meId}>${otherId}`];
    delete this.links[this.pairKey(meId, otherId)];
    this.persist();
  }

  // Only the admin can create or remove an admin grant. The subject has no path to
  // change it: the grant is keyed by the admin, and the subject's call is refused.
  setAdmin(meId, otherId, on) {
    this.requireLink(meId, otherId);
    const key = `${meId}>${otherId}`;
    if (on) {
      if (!this.grants[key]) this.grants[key] = { admin: meId, subject: otherId, createdAt: Date.now() };
    } else {
      if (!this.grants[key] && this.grants[`${otherId}>${meId}`]) {
        throw new HttpError(403, 'An admin has set this. Only they can change it.');
      }
      delete this.grants[key];
    }
    this.persist();
    return this.contactView(meId, otherId);
  }

  // ---------- visibility and position ----------

  setVisible(meId, visible) {
    const me = this.requireUser(meId);
    me.visible = Boolean(visible);
    this.persist();
    return this.publicMe(me);
  }

  setPosition(meId, { lat, lon, accuracy }) {
    const me = this.requireUser(meId);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new HttpError(400, 'Invalid coordinates');
    }
    me.position = {
      lat,
      lon,
      accuracy: Number.isFinite(accuracy) ? Math.max(0, accuracy) : null,
      t: Date.now(),
    };
    // Not persisted on every ping; positions are ephemeral and kept in memory only.
    return me.position;
  }

  // ---------- views ----------

  // Whether `viewerId` may see `targetId`'s position. Admin grants override the toggle.
  canSee(viewerId, targetId) {
    const target = this.users[targetId];
    if (!target) return false;
    return target.visible || Boolean(this.grants[`${viewerId}>${targetId}`]);
  }

  publicMe(user) {
    const adminsOverMe = Object.values(this.grants)
      .filter((g) => g.subject === user.id)
      .map((g) => this.users[g.admin]?.name)
      .filter(Boolean);
    return {
      id: user.id,
      name: user.name,
      visible: user.visible,
      code: `${user.id}.${user.code}`,
      position: user.position,
      // The subject sees that the visibility toggle is overridden, but cannot change it.
      adminsOverMe,
    };
  }

  contactView(meId, otherId) {
    const other = this.users[otherId];
    const link = this.links[this.pairKey(meId, otherId)];
    const seeThem = this.canSee(meId, otherId);
    const seesYou = this.canSee(otherId, meId);
    const pos = seeThem ? other.position : null;
    return {
      id: other.id,
      name: other.name,
      nick: link?.nick?.[meId] ?? null,
      visible: other.visible,
      seeingThem: seeThem,
      theyCanSeeYou: seesYou,
      youAdminThem: Boolean(this.grants[`${meId}>${otherId}`]),
      themAdminYou: Boolean(this.grants[`${otherId}>${meId}`]),
      position: pos ? { lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy, t: pos.t } : null,
      hidden: !seeThem,
    };
  }

  state(meId) {
    const me = this.requireUser(meId);
    const contacts = Object.values(this.links)
      .filter((l) => l.members.includes(meId))
      .map((l) => this.contactView(meId, l.members[0] === meId ? l.members[1] : l.members[0]))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { me: this.publicMe(me), contacts };
  }

  // ---------- helpers ----------

  requireUser(id) {
    const u = this.users[id];
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  }

  requireLink(meId, otherId) {
    const link = this.links[this.pairKey(meId, otherId)];
    if (!link) throw new HttpError(404, 'Not in your contacts');
    return link;
  }
}
