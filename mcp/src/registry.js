'use strict';

const { Session, newSessionId } = require('./session');

class SessionRegistry {
  constructor({ workspace }) {
    this.workspace = workspace;
    this.sessions = new Map();
  }

  async create(options = {}) {
    const id = options.sessionId ? String(options.sessionId) : newSessionId();
    if (this.sessions.has(id)) throw new Error(`session ${id} already exists`);
    const session = new Session({ id, workspace: this.workspace, options });
    this.sessions.set(id, session);
    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(id);
      // A game process or Chromium may already be up even though start threw.
      await session.close().catch(() => {});
      throw error;
    }
    return session;
  }

  get(id) {
    const session = this.sessions.get(String(id));
    if (!session) {
      const known = [...this.sessions.keys()];
      const hint = known.length ? ` known sessions: ${known.join(', ')}` : ' no sessions are running';
      throw new Error(`unknown session_id "${id}".${hint}`);
    }
    return session;
  }

  async end(id) {
    const session = this.get(id);
    const summary = session.summary();
    await session.close();
    this.sessions.delete(session.id);
    return { ...summary, closed: true };
  }

  list() {
    return [...this.sessions.values()].map((session) => session.summary());
  }

  // Chromium and any spawned game process are detached children; without this
  // a server shutdown orphans the whole tree.
  async closeAll() {
    const closing = [...this.sessions.values()].map((session) => session.close().catch(() => {}));
    this.sessions.clear();
    await Promise.all(closing);
  }
}

module.exports = {
  SessionRegistry,
};
