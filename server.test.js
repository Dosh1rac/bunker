const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBunkerServer,
  DISASTERS,
  BUNKERS,
  PROFESSIONS,
  BIOLOGIES,
  HEALTHS,
  HOBBIES,
  PHOBIAS,
  LUGGAGE,
  CHARACTERS,
  FACTS,
  TRAIT_KEYS,
  SPECIAL_CARDS,
  RANDOM_EVENTS,
  DILEMMAS,
  SECRET_GOALS,
  CODE_ALPHABET,
  computeBunkerCapacity,
  validatePlayerName,
  validateRoomSettings,
  evaluateBunkerSurvival,
  evaluateSecretGoal,
  sanitizeChatMessage,
  checkChatFlood
} = require('./server.js');

// Lightweight Socket.IO v4 WebSocket test client using Node's built-in WebSocket (zero external deps)
class TestSocketClient {
  constructor(url) {
    this.url = url.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
    this.ws = null;
    this.ackId = 1;
    this.pendingAcks = new Map();
    this.events = new Map();
    this.latestState = null;
    this.latestPrivate = null;
    this.kicked = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let connected = false;

      ws.addEventListener('message', (ev) => {
        const msg = String(ev.data);
        if (msg === '2') {
          ws.send('3'); // pong
          return;
        }
        if (msg.startsWith('0')) {
          ws.send('40'); // connect namespace /
          return;
        }
        if (msg.startsWith('40')) {
          connected = true;
          resolve();
          return;
        }
        if (msg.startsWith('42')) {
          const parsed = JSON.parse(msg.slice(2));
          const [eventName, payload] = parsed;
          if (eventName === 'room:state') this.latestState = payload;
          if (eventName === 'player:private') this.latestPrivate = payload;
          if (eventName === 'room:kicked') this.kicked = true;
          const handlers = this.events.get(eventName) || [];
          for (const h of handlers) h(payload);
          return;
        }
        if (msg.startsWith('43')) {
          const match = /^43(\d+)(.*)$/.exec(msg);
          if (match) {
            const id = Number(match[1]);
            const args = JSON.parse(match[2]);
            const resolver = this.pendingAcks.get(id);
            if (resolver) {
              this.pendingAcks.delete(id);
              resolver(args[0]);
            }
          }
        }
      });

      ws.addEventListener('error', (err) => {
        if (!connected) reject(err);
      });
    });
  }

  emit(event, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = this.ackId++;
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error(`Ack timeout for ${event}`));
      }, 4000);
      this.pendingAcks.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.ws.send(`42${id}${JSON.stringify([event, payload])}`);
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('Database minimums and code alphabet requirements', () => {
  assert.ok(DISASTERS.length >= 15, 'At least 15 disasters');
  assert.ok(BUNKERS.length >= 15, 'At least 15 bunkers');
  assert.ok(PROFESSIONS.length >= 25, 'At least 25 professions');
  assert.ok(BIOLOGIES.length >= 25, 'At least 25 biologies');
  assert.ok(HEALTHS.length >= 25, 'At least 25 health states');
  assert.ok(HOBBIES.length >= 25, 'At least 25 hobbies');
  assert.ok(PHOBIAS.length >= 25, 'At least 25 phobias');
  assert.ok(LUGGAGE.length >= 25, 'At least 25 luggage items');
  assert.ok(CHARACTERS.length >= 25, 'At least 25 characters');
  assert.ok(FACTS.length >= 25, 'At least 25 facts');
  assert.equal(TRAIT_KEYS.length, 8, '8 character stat categories');
  assert.ok(TRAIT_KEYS.includes('character') && TRAIT_KEYS.includes('fact'));
  assert.ok(SPECIAL_CARDS.length >= 25, 'At least 25 special cards');
  assert.ok(RANDOM_EVENTS.length >= 15, 'At least 15 random events');

  assert.equal(CODE_ALPHABET.includes('O'), false);
  assert.equal(CODE_ALPHABET.includes('0'), false);
  assert.equal(CODE_ALPHABET.includes('I'), false);
  assert.equal(CODE_ALPHABET.includes('1'), false);

  assert.equal(computeBunkerCapacity(3), 1);
  assert.equal(computeBunkerCapacity(4), 2);
  assert.equal(computeBunkerCapacity(5), 2);
  assert.equal(computeBunkerCapacity(6), 3);
  assert.equal(computeBunkerCapacity(8), 4);
  assert.equal(computeBunkerCapacity(10), 5);

  assert.equal(validatePlayerName('А').valid, false);
  assert.equal(validatePlayerName('Алекс').valid, true);
});

test('Chat sanitization, 500-char limit, newlines, emoji, XSS prevention, and flood protection', () => {
  // Valid Russian + emoji + newlines
  const okMsg = sanitizeChatMessage('  Привет!\nЯ врач 🩺 и спасаю людей!\r\nГолосуем с умом.  ', 500);
  assert.equal(okMsg.valid, true);
  assert.equal(okMsg.text, 'Привет!\nЯ врач 🩺 и спасаю людей!\nГолосуем с умом.');

  // Strips HTML angle brackets
  const xssMsg = sanitizeChatMessage('<script>alert(1)</script>Безопасно', 500);
  assert.equal(xssMsg.valid, true);
  assert.equal(xssMsg.text.includes('<'), false);
  assert.equal(xssMsg.text.includes('>'), false);

  // Rejects empty / whitespace only
  assert.equal(sanitizeChatMessage('   \n\n  ', 500).valid, false);

  // Enforces 500 code-point limit (with emoji)
  const exact500 = '🔥'.repeat(500);
  assert.equal(sanitizeChatMessage(exact500, 500).valid, true);
  const over500 = 'а'.repeat(501);
  assert.equal(sanitizeChatMessage(over500, 500).valid, false);

  // Flood protection: cooldown, duplicate, burst 5/10s
  const mockPlayer = {};
  assert.equal(checkChatFlood(mockPlayer, 'Первое', 1000).ok, true);
  assert.equal(checkChatFlood(mockPlayer, 'Быстрое', 1200).ok, false, 'Rejects <700ms cooldown');
  assert.equal(checkChatFlood(mockPlayer, 'Первое', 2500).ok, false, 'Rejects duplicate within 12s');
  assert.equal(checkChatFlood(mockPlayer, 'Второе', 2000).ok, true);
  assert.equal(checkChatFlood(mockPlayer, 'Третье', 3000).ok, true);
  assert.equal(checkChatFlood(mockPlayer, 'Четвёртое', 4000).ok, true);
  assert.equal(checkChatFlood(mockPlayer, 'Пятое', 5000).ok, true);
  assert.equal(checkChatFlood(mockPlayer, 'Шестое', 6000).ok, false, 'Rejects >5 messages in 10s');
  assert.equal(checkChatFlood(mockPlayer, 'После окна', 12000).ok, true, 'Allows once window clears');
});

test('Full multiplayer lifecycle: 3-10 players, limits, unique cards, secrecy, special cards, voting, ties, exile, reconnect, host migration, victory', async () => {
  const srv = createBunkerServer({
    discussionSeconds: 2,
    votingSeconds: 2,
    hostMigrationMs: 250,
    offlineKickMs: 100,
    roomCleanupMs: 5000,
    disableRandomEvents: false,
    disableDilemmas: true
  });

  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  const port = srv.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const clients = [];
  try {
    // 1. Create room & try starting with 2 players (should fail)
    const host = new TestSocketClient(baseUrl);
    await host.connect();
    clients.push(host);

    const createRes = await host.emit('room:create', { name: 'Хост_1' });
    assert.equal(createRes.ok, true);
    assert.match(createRes.roomCode, /^[A-HJ-NP-Z2-9]{4}$/);
    const code = createRes.roomCode;

    const p2 = new TestSocketClient(baseUrl);
    await p2.connect();
    clients.push(p2);
    const j2 = await p2.emit('room:join', { name: 'Игрок_2', code });
    assert.equal(j2.ok, true);

    // Duplicate name blocked
    const dupRes = await p2.emit('room:join', { name: 'игрок_2', code });
    assert.equal(dupRes.ok, false);

    // Scenario 5: Start with 2 players rejected
    const failStart = await host.emit('game:start');
    assert.equal(failStart.ok, false);

    // Connect up to 10 players (Scenarios 2 & 3)
    for (let i = 3; i <= 10; i++) {
      const c = new TestSocketClient(baseUrl);
      await c.connect();
      clients.push(c);
      const jr = await c.emit('room:join', { name: `Игрок_${i}`, code });
      assert.equal(jr.ok, true, `Player ${i} should join`);
    }

    // Attempt 11th player -> rejected
    const p11 = new TestSocketClient(baseUrl);
    await p11.connect();
    clients.push(p11);
    const j11 = await p11.emit('room:join', { name: 'Игрок_11', code });
    assert.equal(j11.ok, false);
    p11.close();
    clients.pop();

    await wait(110);
    // Start game with 10 players -> capacity 5
    const startRes = await host.emit('game:start');
    assert.equal(startRes.ok, true, startRes.error);
    await wait(60);

    assert.equal(host.latestState.phase, 'discussion');
    assert.equal(host.latestState.bunkerCapacity, 5);

    // Scenario 6 & 13: Verify unique traits across all 10 players AND hidden traits are NEVER leaked in public state
    const seenProfs = new Set();
    const seenCharacters = new Set();
    const seenFacts = new Set();
    for (const c of clients) {
      assert.ok(c.latestPrivate, 'Client received private state');
      assert.ok(c.latestPrivate.traits.profession.data.title);
      assert.ok(c.latestPrivate.traits.character.data.title);
      assert.ok(c.latestPrivate.traits.fact.data.title);
      seenProfs.add(c.latestPrivate.traits.profession.data.title);
      seenCharacters.add(c.latestPrivate.traits.character.data.title);
      seenFacts.add(c.latestPrivate.traits.fact.data.title);

      // Public state must NOT contain hidden trait data of any player
      for (const pubPlayer of c.latestState.players) {
        for (const k of TRAIT_KEYS) {
          assert.equal(pubPlayer.traits[k].revealed, false);
          assert.equal(pubPlayer.traits[k].data, null);
        }
        assert.equal(pubPlayer.specialCardPublic, null);
      }
    }
    assert.equal(seenProfs.size, 10, 'All 10 players have unique professions');
    assert.equal(seenCharacters.size, 10, 'All 10 players have unique character traits');
    assert.equal(seenFacts.size, 10, 'All 10 players have unique background facts');

    // Scenario 7, 8, 9: Reveal own trait (including new character & fact stats), cannot reveal twice in one round
    const rev1 = await host.emit('game:revealTrait', { traitKey: 'profession' });
    assert.equal(rev1.ok, true);
    const revChar = await clients[1].emit('game:revealTrait', { traitKey: 'character' });
    assert.equal(revChar.ok, true);
    const revFact = await clients[2].emit('game:revealTrait', { traitKey: 'fact' });
    assert.equal(revFact.ok, true);
    const rev2 = await host.emit('game:revealTrait', { traitKey: 'health' });
    assert.equal(rev2.ok, false);
    const revSame = await host.emit('game:revealTrait', { traitKey: 'profession' });
    assert.equal(revSame.ok, false);

    // Scenario 10 & 11: Use special card and prevent double-use
    const sc = host.latestPrivate.specialCard;
    const targetId = clients[1].latestPrivate.playerId;
    if (sc.id !== 'reconsider_verdict' && sc.id !== 'immunity') {
      const scRes = await host.emit('game:useSpecial', sc.requiresTarget ? { targetId } : {});
      if (scRes.ok) {
        const scDouble = await host.emit('game:useSpecial', sc.requiresTarget ? { targetId } : {});
        assert.equal(scDouble.ok, false, 'Special card cannot be used twice');
      }
    }

    // Scenario 18, 19, 20: Disconnect & Reconnect with token
    p2.close();
    await wait(60);
    const p2Disconnected = host.latestState.players.find((p) => p.id === j2.playerId);
    assert.equal(p2Disconnected.connected, false);

    const p2Reconnected = new TestSocketClient(baseUrl);
    await p2Reconnected.connect();
    clients[1] = p2Reconnected;
    const recRes = await p2Reconnected.emit('session:reconnect', { roomCode: code, token: j2.token });
    assert.equal(recRes.ok, true);
    await wait(60);
    const p2Online = host.latestState.players.find((p) => p.id === j2.playerId);
    assert.equal(p2Online.connected, true);

    // Scenario 21: Host disconnect & migration after 250ms
    host.close();
    await wait(350);
    assert.notEqual(p2Reconnected.latestState.hostId, createRes.playerId, 'Host migrated away from offline host');

    // Reconnect old host -> does NOT automatically reclaim host
    const hostReconnected = new TestSocketClient(baseUrl);
    await hostReconnected.connect();
    clients[0] = hostReconnected;
    await hostReconnected.emit('session:reconnect', { roomCode: code, token: createRes.token });
    await wait(60);
    assert.notEqual(hostReconnected.latestState.hostId, createRes.playerId, 'Old host does not reclaim host');

    // Find current host client
    const currentHostId = hostReconnected.latestState.hostId;
    const currentHostClient = clients.find((c) => c.latestPrivate.playerId === currentHostId);
    assert.ok(currentHostClient);

    // Scenario 14 & 15: Tie -> Runoff -> Second Tie (nobody exiled)
    await currentHostClient.emit('game:endDiscussion');
    await wait(60);
    assert.equal(currentHostClient.latestState.phase, 'voting');

    // Cannot vote for self
    const selfVote = await currentHostClient.emit('game:vote', { targetId: currentHostId });
    assert.equal(selfVote.ok, false);

    // Cast 1 vote for player[8] and 1 vote for player[9]
    const candA = clients[8].latestPrivate.playerId;
    const candB = clients[9].latestPrivate.playerId;
    await clients[3].emit('game:vote', { targetId: candA });
    await clients[4].emit('game:vote', { targetId: candB });
    const ev1 = await currentHostClient.emit('game:endVoting');
    assert.equal(ev1.ok, true, ev1.error);
    await wait(120);

    assert.equal(currentHostClient.latestState.phase, 'runoff', 'Tie triggers runoff');
    // Second tie in runoff -> nobody exiled -> advances to round 2
    await clients[3].emit('game:vote', { targetId: candA });
    await clients[4].emit('game:vote', { targetId: candB });
    const ev2 = await currentHostClient.emit('game:endVoting');
    assert.equal(ev2.ok, true, ev2.error);
    await wait(120);

    assert.equal(currentHostClient.latestState.phase, 'discussion');
    assert.equal(currentHostClient.latestState.round, 2);

    // Scenario 16, 17, 22: Exile players until alive <= bunkerCapacity (5) -> Game ends!
    for (let exileStep = 0; exileStep < 5; exileStep++) {
      const activeHostId = currentHostClient.latestState.hostId;
      const activeHost = clients.find((c) => c.latestPrivate.playerId === activeHostId);
      if (activeHost.latestState.phase === 'ended') break;

      await wait(110);
      const ed = await activeHost.emit('game:endDiscussion');
      assert.equal(ed.ok, true, ed.error);
      await wait(50);

      const aliveTargets = activeHost.latestState.players.filter((p) => p.alive);
      const voter1 = clients.find((c) => c.latestPrivate.playerId === aliveTargets[0].id);
      const voter2 = clients.find((c) => c.latestPrivate.playerId === aliveTargets[1].id);
      const victim = aliveTargets[aliveTargets.length - 1];

      await voter1.emit('game:vote', { targetId: victim.id });
      await voter2.emit('game:vote', { targetId: victim.id });
      await wait(110);
      const ev = await activeHost.emit('game:endVoting');
      assert.equal(ev.ok, true, ev.error);
      await wait(50);

      // Check exiled player cannot vote or reveal if game still running, BUT can still chat as spectator
      if (activeHost.latestState.phase !== 'ended') {
        const exiledClient = clients.find((c) => c.latestPrivate.playerId === victim.id);
        const exiledAction = await exiledClient.emit('game:revealTrait', { traitKey: 'hobby' });
        assert.equal(exiledAction.ok, false, 'Exiled player cannot reveal traits');

        const exiledChat = await exiledClient.emit('chat:send', { text: 'Я всё ещё наблюдаю 👀\nУдачи в бункере!' });
        assert.equal(exiledChat.ok, true, 'Exiled player can chat as spectator');
        assert.equal(exiledChat.message.senderExiled, true);
        assert.equal(typeof exiledChat.message.senderAvatarId, 'number');
        assert.ok(exiledChat.message.text.includes('\n'));
      }
    }

    assert.equal(currentHostClient.latestState.phase, 'ended', 'Game ended when alive <= bunkerCapacity');
    assert.ok(currentHostClient.latestState.endSummary.survivors.length <= 5);

    // Verify 500-char chat limit, XSS sanitization, flood protection, and system event types in room chat
    const chatHost = clients.find((c) => c.latestPrivate.playerId === currentHostClient.latestState.hostId);
    const overLimitChat = await chatHost.emit('chat:send', { text: 'Я'.repeat(501) });
    assert.equal(overLimitChat.ok, false, 'Server rejects messages >500 chars');

    const multiEmojiChat = await chatHost.emit('chat:send', { text: '<b>Финал</b>!\nМы выжили 🛡️🔥' });
    assert.equal(multiEmojiChat.ok, true, multiEmojiChat.error);
    assert.equal(multiEmojiChat.message.text, 'bФинал/b!\nМы выжили 🛡️🔥');

    const rapidFlood = await chatHost.emit('chat:send', { text: 'Спам сразу' });
    assert.equal(rapidFlood.ok, false, 'Server rejects rapid flood <700ms');

    const sysTypes = new Set(chatHost.latestState.chat.map((m) => m.type));
    assert.ok(sysTypes.has('join'), 'Chat records join system messages');
    assert.ok(sysTypes.has('round'), 'Chat records round start system messages');
    assert.ok(sysTypes.has('voting'), 'Chat records voting system messages');
    assert.ok(sysTypes.has('exile'), 'Chat records exile system messages');
    assert.ok(sysTypes.has('gameover'), 'Chat records gameover system messages');
    assert.ok(sysTypes.has('user'), 'Chat records user messages');

    // Scenario 23: Play again starts fresh round 1
    const againHost = clients.find((c) => c.latestPrivate.playerId === currentHostClient.latestState.hostId);
    const playAgainRes = await againHost.emit('game:playAgain');
    assert.equal(playAgainRes.ok, true);
    await wait(60);
    assert.equal(againHost.latestState.phase, 'discussion');
    assert.equal(againHost.latestState.round, 1);
  } finally {
    for (const c of clients) c.close();
    await srv.close();
  }
});

test('Skip Vote: 3 skips per game, 4th rejected, quorum advances with 0 exiles, exiled blocked, resets on playAgain', async () => {
  const srv = createBunkerServer({
    discussionSeconds: 30,
    votingSeconds: 30,
    disableRandomEvents: true,
    disableDilemmas: true
  });

  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  const port = srv.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients = [];

  try {
    const c1 = new TestSocketClient(baseUrl);
    const c2 = new TestSocketClient(baseUrl);
    const c3 = new TestSocketClient(baseUrl);
    const c4 = new TestSocketClient(baseUrl);
    clients.push(c1, c2, c3, c4);
    for (const c of clients) await c.connect();

    const r1 = await c1.emit('room:create', { name: 'Хост' });
    assert.equal(r1.ok, true);
    const code = r1.roomCode;
    assert.equal((await c2.emit('room:join', { name: 'Алиса', code })).ok, true);
    assert.equal((await c3.emit('room:join', { name: 'Борис', code })).ok, true);
    assert.equal((await c4.emit('room:join', { name: 'Вера', code })).ok, true);

    assert.equal((await c1.emit('game:start')).ok, true);
    await wait(60);
    assert.equal(c1.latestPrivate.skipsRemaining, 3);
    assert.equal(c1.latestPrivate.skipsUsed, 0);

    // Round 1, 2, 3: all 4 alive players skip -> resolves immediately with 0 exiles and advances round
    for (let round = 1; round <= 3; round++) {
      await wait(120);
      assert.equal((await c1.emit('game:endDiscussion')).ok, true);
      await wait(40);
      assert.equal(c1.latestState.phase, 'voting');

      // c1 skips
      const s1 = await c1.emit('game:skipVote');
      assert.equal(s1.ok, true, s1.error);
      assert.equal(s1.skipsRemaining, 3 - round);
      await wait(40);
      assert.equal(c1.latestPrivate.skippedThisVote, true);
      assert.equal(c1.latestPrivate.votedForId, null);
      assert.equal(c1.latestPrivate.skipsRemaining, 3 - round);

      // Cannot skip twice or vote after skipping in the same voting phase
      await wait(210);
      assert.equal((await c1.emit('game:skipVote')).ok, false, 'Cannot skip twice in one vote');
      assert.equal((await c1.emit('game:vote', { targetId: c2.latestPrivate.playerId })).ok, false, 'Cannot vote after skipping');

      // Remaining 3 players also skip -> immediate quorum resolution -> next discussion round
      assert.equal((await c2.emit('game:skipVote')).ok, true);
      assert.equal((await c3.emit('game:skipVote')).ok, true);
      assert.equal((await c4.emit('game:skipVote')).ok, true);
      await wait(60);

      assert.equal(c1.latestState.phase, 'discussion', `All-skip quorum should advance from round ${round}`);
      assert.equal(c1.latestState.round, round + 1);
      assert.equal(c1.latestState.players.filter((p) => p.alive).length, 4, 'No player exiled when everyone skips');
    }

    // Round 4: 4th skip must be rejected!
    await wait(120);
    assert.equal((await c1.emit('game:endDiscussion')).ok, true);
    await wait(40);
    const fourthSkip = await c1.emit('game:skipVote');
    assert.equal(fourthSkip.ok, false, '4th skip in same game must fail');
    assert.equal(c1.latestPrivate.skipsRemaining, 0);

    // Vote c4 out while c1 tests cannot skip after voting
    await wait(210);
    assert.equal((await c1.emit('game:vote', { targetId: c4.latestPrivate.playerId })).ok, true);
    await wait(210);
    assert.equal((await c1.emit('game:skipVote')).ok, false, 'Cannot skip after casting vote');
    assert.equal((await c2.emit('game:vote', { targetId: c4.latestPrivate.playerId })).ok, true);
    assert.equal((await c3.emit('game:vote', { targetId: c4.latestPrivate.playerId })).ok, true);
    assert.equal((await c4.emit('game:vote', { targetId: c3.latestPrivate.playerId })).ok, true);
    await wait(60);

    // 4 players -> capacity 2, 3 alive -> Round 5 (c4 is now exiled)
    assert.equal(c1.latestState.phase, 'discussion');
    assert.equal(c1.latestState.players.find((p) => p.id === c4.latestPrivate.playerId).alive, false);

    // Verify exiled player cannot skip in an active vote
    await wait(120);
    assert.equal((await c1.emit('game:endDiscussion')).ok, true);
    await wait(40);
    const exiledSkip = await c4.emit('game:skipVote');
    assert.equal(exiledSkip.ok, false, 'Exiled player cannot skip vote');

    // Exile c3 so 2 alive <= capacity 2 -> game ends
    await wait(210);
    assert.equal((await c1.emit('game:vote', { targetId: c3.latestPrivate.playerId })).ok, true);
    assert.equal((await c2.emit('game:vote', { targetId: c3.latestPrivate.playerId })).ok, true);
    assert.equal((await c3.emit('game:vote', { targetId: c2.latestPrivate.playerId })).ok, true);
    await wait(60);
    assert.equal(c1.latestState.phase, 'ended');

    // Play again resets skipsRemaining back to 3 for everyone
    assert.equal((await c1.emit('game:playAgain')).ok, true);
    await wait(60);
    assert.equal(c1.latestState.phase, 'discussion');
    assert.equal(c1.latestState.round, 1);
    assert.equal(c1.latestPrivate.skipsRemaining, 3);
    assert.equal(c2.latestPrivate.skipsRemaining, 3);
    assert.equal(c4.latestPrivate.skipsRemaining, 3);
  } finally {
    for (const c of clients) c.close();
    await srv.close();
  }
});

test('Unit tests: validateRoomSettings, evaluateBunkerSurvival, and evaluateSecretGoal', () => {
  assert.ok(DILEMMAS.length >= 6);
  assert.ok(SECRET_GOALS.length >= 6);

  const defSettings = validateRoomSettings({});
  assert.equal(defSettings.discussionSeconds, 120);
  assert.equal(defSettings.votingSeconds, 45);
  assert.equal(defSettings.maxSkips, 3);
  assert.equal(defSettings.forceProfessionRound1, false);
  assert.equal(defSettings.enableDilemmas, true);
  assert.equal(defSettings.enableSecretRoles, true);

  const customSettings = validateRoomSettings({
    discussionSeconds: 60,
    votingSeconds: 30,
    maxSkips: 1,
    forceProfessionRound1: true,
    enableRandomEvents: false,
    enableDilemmas: false,
    enableSecretRoles: false
  });
  assert.equal(customSettings.discussionSeconds, 60);
  assert.equal(customSettings.votingSeconds, 30);
  assert.equal(customSettings.maxSkips, 1);
  assert.equal(customSettings.forceProfessionRound1, true);
  assert.equal(customSettings.enableRandomEvents, false);
  assert.equal(customSettings.enableDilemmas, false);
  assert.equal(customSettings.enableSecretRoles, false);

  // Invalid numeric options fall back to defaults
  const invalidFallback = validateRoomSettings({ discussionSeconds: 999, votingSeconds: 12, maxSkips: 99 });
  assert.equal(invalidFallback.discussionSeconds, 120);
  assert.equal(invalidFallback.votingSeconds, 45);
  assert.equal(invalidFallback.maxSkips, 3);

  const idealRoom = {
    settings: { maxSkips: 3 },
    game: {
      bunker: { foodMonths: 14, waterPercent: 90, powerPercent: 90, malfunctions: [] }
    },
    players: [
      {
        id: 'p1',
        alive: true,
        everRunoff: false,
        skipsUsed: 0,
        specialCard: { used: true },
        secretGoal: { id: 'tactician', title: 'Тактик', description: '...' },
        traits: {
          profession: { data: { title: 'Хирург' } },
          health: { data: { severity: 'none' } },
          biology: { data: { fertility: 'Фертилен' } },
          hobby: { data: { title: 'Кулинария' } },
          luggage: { data: { title: 'Полевая аптечка' } }
        }
      },
      {
        id: 'p2',
        alive: true,
        everRunoff: true,
        skipsUsed: 3,
        specialCard: { used: false },
        secretGoal: { id: 'save_medic', title: 'Беречь врача', description: '...' },
        traits: {
          profession: { data: { title: 'Инженер-ядерщик' } },
          health: { data: { severity: 'none' } },
          biology: { data: { fertility: 'Фертилен' } },
          hobby: { data: { title: 'Растениеводство' } },
          luggage: { data: { title: 'Набор инструментов' } }
        }
      }
    ]
  };
  const goodReport = evaluateBunkerSurvival(idealRoom);
  assert.equal(goodReport.score, 100);
  assert.equal(goodReport.checks.length, 5);
  assert.equal(goodReport.verdictTone, 'success');
  assert.equal(evaluateSecretGoal(idealRoom.players[0], idealRoom, goodReport).achieved, true);
  assert.equal(evaluateSecretGoal(idealRoom.players[1], idealRoom, goodReport).achieved, true);
});

test('New features integration: avatars, settings, bots, pause, dilemmas, whispers, reactions, and survival report', async () => {
  const srv = createBunkerServer({
    discussionSeconds: 60,
    votingSeconds: 30,
    dilemmaSeconds: 20,
    disableRandomEvents: true,
    disableDilemmas: false
  });

  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  const port = srv.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients = [];

  try {
    const c1 = new TestSocketClient(baseUrl);
    const c2 = new TestSocketClient(baseUrl);
    const c3 = new TestSocketClient(baseUrl);
    clients.push(c1, c2, c3);
    for (const c of clients) await c.connect();

    const r1 = await c1.emit('room:create', { name: 'Альфа' });
    const code = r1.roomCode;
    await c2.emit('room:join', { name: 'Бета', code });
    await c3.emit('room:join', { name: 'Гамма', code });

    // Avatar picker
    const avRes = await c2.emit('lobby:setAvatar', { avatarId: 7 });
    assert.equal(avRes.ok, true);
    await wait(40);
    const betaPub = c1.latestState.players.find((p) => p.name === 'Бета');
    assert.equal(betaPub.avatarId, 7);

    // Host settings + non-host rejection
    const nonHostSettings = await c2.emit('lobby:updateSettings', { maxSkips: 0 });
    assert.equal(nonHostSettings.ok, false);

    const hostSettings = await c1.emit('lobby:updateSettings', {
      discussionSeconds: 60,
      votingSeconds: 30,
      maxSkips: 1,
      forceProfessionRound1: true,
      enableRandomEvents: false,
      enableDilemmas: true,
      enableSecretRoles: true
    });
    assert.equal(hostSettings.ok, true);
    assert.equal(hostSettings.settings.maxSkips, 1);
    assert.equal(hostSettings.settings.forceProfessionRound1, true);

    // Add & Remove Bot
    const botAdd = await c1.emit('lobby:addBot');
    assert.equal(botAdd.ok, true);
    await wait(220);
    assert.equal(c1.latestState.players.length, 4);
    assert.equal(c1.latestState.players.some((p) => p.isBot), true);

    const botRem = await c1.emit('lobby:removeBot', { targetId: botAdd.botId });
    assert.equal(botRem.ok, true);
    await wait(220);
    // Add bot back so 4 players -> capacity 2, round 1 -> 1 exile -> round 2
    const botAdd2 = await c1.emit('lobby:addBot');
    assert.equal(botAdd2.ok, true);

    await wait(110);
    assert.equal((await c1.emit('game:start')).ok, true);
    await wait(60);

    // Verify secretGoal is private only and NOT in public room:state
    assert.ok(c1.latestPrivate.secretGoal);
    assert.equal(c1.latestPrivate.maxSkips, 1);
    assert.equal(c1.latestPrivate.skipsRemaining, 1);
    assert.equal('secretGoal' in c1.latestState.players[0], false);

    // forceProfessionRound1 rejects non-profession first reveal, allows profession
    const badReveal = await c1.emit('game:revealTrait', { traitKey: 'hobby' });
    assert.equal(badReveal.ok, false);
    await wait(220);
    const profReveal = await c1.emit('game:revealTrait', { traitKey: 'profession' });
    assert.equal(profReveal.ok, true);

    // Pause / resume
    const p1 = await c1.emit('game:togglePause');
    assert.equal(p1.ok, true);
    assert.equal(p1.paused, true);
    await wait(220);
    const p2 = await c1.emit('game:togglePause');
    assert.equal(p2.ok, true);
    assert.equal(p2.paused, false);

    // Chat reaction & strict Whisper privacy
    const chatRes = await c1.emit('chat:send', { text: 'Проверяем реакцию!' });
    assert.equal(chatRes.ok, true);
    const reactRes = await c2.emit('chat:react', { messageId: chatRes.message.id, emoji: '👍' });
    assert.equal(reactRes.ok, true);
    assert.equal(reactRes.reactions['👍'].length, 1);
    await wait(180);
    const badReact = await c2.emit('chat:react', { messageId: chatRes.message.id, emoji: '💩' });
    assert.equal(badReact.ok, false);

    const c1Whispers = [];
    const c2Whispers = [];
    const c3Whispers = [];
    c1.events.set('chat:whisperMessage', [(w) => c1Whispers.push(w)]);
    c2.events.set('chat:whisperMessage', [(w) => c2Whispers.push(w)]);
    c3.events.set('chat:whisperMessage', [(w) => c3Whispers.push(w)]);

    const w1 = await c1.emit('chat:whisper', { targetId: c2.latestPrivate.playerId, text: 'Договоримся против Гаммы' });
    assert.equal(w1.ok, true);
    assert.equal(w1.whispersRemaining, 1);
    await wait(450);
    const w2 = await c1.emit('chat:whisper', { targetId: c2.latestPrivate.playerId, text: 'Второй шёпот' });
    assert.equal(w2.ok, true);
    assert.equal(w2.whispersRemaining, 0);
    await wait(450);
    const w3 = await c1.emit('chat:whisper', { targetId: c2.latestPrivate.playerId, text: 'Третий лишний' });
    assert.equal(w3.ok, false, 'Max 2 whispers per round');

    assert.equal(c1Whispers.length, 2, 'Sender sees both whispers');
    assert.equal(c2Whispers.length, 2, 'Recipient sees both whispers');
    assert.equal(c3Whispers.length, 0, 'Third party MUST NEVER see private whispers');

    // End discussion -> Voting -> Skip + Votes -> triggers Dilemma before Round 2
    await wait(120);
    assert.equal((await c1.emit('game:endDiscussion')).ok, true);
    await wait(150);
    assert.equal(c1.latestState.phase, 'voting');

    // Vote tie or skip to keep all 4 alive -> advances to dilemma phase
    assert.equal((await c1.emit('game:skipVote')).ok, true);
    assert.equal((await c2.emit('game:skipVote')).ok, true);
    assert.equal((await c3.emit('game:skipVote')).ok, true);
    await wait(150);
    assert.equal((await c1.emit('game:endVoting')).ok, true);
    await wait(120);

    // Dilemma phase triggered! Vote ЗА from humans & endDilemma
    assert.equal(c1.latestState.phase, 'dilemma', 'Between rounds enters dilemma phase');
    assert.ok(c1.latestState.dilemmaInfo.title);
    assert.equal((await c1.emit('game:voteDilemma', { choice: 'yes' })).ok, true);
    assert.equal((await c2.emit('game:voteDilemma', { choice: 'yes' })).ok, true);
    await wait(120);
    assert.equal((await c1.emit('game:endDilemma')).ok, true);
    await wait(100);

    assert.equal(c1.latestState.phase, 'discussion', 'After dilemma moves to Round 2 discussion');
    assert.equal(c1.latestState.round, 2);

    // Wait for bot auto-reveal to verify bot works in discussion
    await wait(1500);
    const botPlayer = c1.latestState.players.find((p) => p.isBot);
    assert.equal(botPlayer.revealedThisRound, true, 'Bot automatically reveals a trait in discussion');

    // Exile two players across voting to reach capacity 2 -> ended with survivalReport & goalResults
    for (let step = 0; step < 2; step++) {
      if (c1.latestState.phase === 'ended') break;
      if (c1.latestState.phase === 'dilemma') {
        await wait(120);
        await c1.emit('game:endDilemma');
        await wait(60);
      }
      await wait(120);
      await c1.emit('game:endDiscussion');
      await wait(60);
      const target = c1.latestState.players.find((p) => p.alive && p.id !== c1.latestPrivate.playerId && p.id !== c2.latestPrivate.playerId);
      await wait(220);
      await c1.emit('game:vote', { targetId: target.id });
      await wait(220);
      await c2.emit('game:vote', { targetId: target.id });
      await wait(120);
      await c1.emit('game:endVoting');
      await wait(80);
    }

    assert.equal(c1.latestState.phase, 'ended');
    assert.ok(c1.latestState.endSummary.survivalReport);
    assert.equal(c1.latestState.endSummary.survivalReport.checks.length, 5);
    assert.equal(c1.latestState.endSummary.goalResults.length, 4);
  } finally {
    for (const c of clients) c.close();
    await srv.close();
  }
});



test('Saved rooms survive a server restart and restore private cards, votes, timers and chat', async () => {
  // Fake adapter exercises the production persistence boundary without a live database.
  const saved = new Map();
  const store = {
    load: async () => [...saved.values()].map((value) => structuredClone(value)),
    save: async (code, snapshot) => { saved.set(code, structuredClone(snapshot)); },
    remove: async (code) => { saved.delete(code); }
  };
  let srv = createBunkerServer({ store, discussionSeconds: 120, disableDilemmas: true });
  let host;
  try {
    await srv.ready;
    await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
    host = new TestSocketClient(`http://127.0.0.1:${srv.server.address().port}`);
    await host.connect();
    const session = await host.emit('room:create', { name: 'Хост' });
    assert.equal(session.ok, true);
    assert.ok(saved.has(session.roomCode), 'Create acknowledgement waits for persistence');
    assert.equal((await host.emit('lobby:addBot')).ok, true);
    await wait(220);
    assert.equal((await host.emit('lobby:addBot')).ok, true);
    assert.equal((await host.emit('game:start')).ok, true);
    assert.equal((await host.emit('chat:send', { text: 'Сохраняем партию' })).ok, true);
    const original = structuredClone(saved.get(session.roomCode));
    assert.equal(original.phase, 'discussion');
    assert.ok(original.timerSeconds > 0);
    assert.ok(original.game.votes.$map);
    assert.ok(original.game.usedDilemmaIds.$set);
    const traits = original.players.find((p) => p.id === session.playerId).traits;
    host.close();
    await srv.close();
    await srv.flush();

    srv = createBunkerServer({ store });
    await srv.ready;
    await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
    host = new TestSocketClient(`http://127.0.0.1:${srv.server.address().port}`);
    await host.connect();
    assert.equal((await host.emit('session:reconnect', session)).ok, true);
    await wait(40);
    const room = srv.rooms.get(session.roomCode);
    assert.equal(room.phase, 'discussion');
    assert.ok(room.phaseInterval, 'Phase countdown resumes on reconnect');
    assert.ok(room.game.votes instanceof Map);
    assert.ok(room.game.usedDilemmaIds instanceof Set);
    assert.deepEqual(room.players.find((p) => p.id === session.playerId).traits, traits);
    assert.ok(room.chat.some((msg) => msg.text === 'Сохраняем партию'));
    assert.equal(host.latestState.players.length, 3);
    assert.equal(host.latestState.players[0].traits.profession.revealed, false);
    assert.ok(host.latestPrivate.traits.profession);
    assert.equal((await host.emit('game:endDiscussion')).ok, true);
    assert.equal(room.phase, 'voting');
  } finally {
    host?.close();
    await srv.close();
    await srv.flush();
  }
});
