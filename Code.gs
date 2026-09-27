function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('人狼オンライン')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ==========================================
// 1. データ保持用ヘルパー (PropertiesService)
// ==========================================
function getRoomsData() {
  const prop = PropertiesService.getScriptProperties();
  const data = prop.getProperty('ROOMS_DATA');
  return data ? JSON.parse(data) : {};
}

function saveRoomsData(rooms) {
  const prop = PropertiesService.getScriptProperties();
  prop.setProperty('ROOMS_DATA', JSON.stringify(rooms));
}

function addLog(room, type, msg, sender = 'SYSTEM') {
  if (!room.logs) room.logs = [];
  const timeStr = Utilities.formatDate(new Date(), "JST", "HH:mm");
  room.logs.push({
    time: timeStr,
    type: type, // 'SYSTEM', 'PRIVATE', 'CHAT', 'WOLF', 'GRAVE', 'SOLILOQUY'
    sender: sender,
    msg: msg
  });
}

// ==========================================
// 2. 部屋管理機能
// ==========================================
function getRoomList() {
  const rooms = getRoomsData();
  const list = [];
  for (let id in rooms) {
    const r = rooms[id];
    list.push({
      id: r.id,
      name: r.name,
      status: r.status === 'LOBBY' ? '待機中' : (r.status === 'FINISHED' ? '終了' : '対戦中'),
      members: r.members
    });
  }
  return list;
}

function createRoom(roomName, hostUsername) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false, message: "混雑しています。やり直してください。" };

  try {
    const rooms = getRoomsData();
    let roomId = Math.floor(1000 + Math.random() * 9000).toString();
    while (rooms[roomId]) {
      roomId = Math.floor(1000 + Math.random() * 9000).toString();
    }

    rooms[roomId] = {
      id: roomId,
      name: roomName,
      host: hostUsername,
      status: 'LOBBY',
      day: 1,
      dayTime: 4,
      voteTime: 1,
      nightTime: 1,
      tieRule: 'random',
      members: [hostUsername],
      roles: {
        villager: 2,
        werewolf: 1,
        seer: 0,
        medium: 0,
        bodyguard: 0,
        madman: 0,
        fox: 0
      },
      players: {},
      logs: [],
      endTime: 0
    };

    addLog(rooms[roomId], 'SYSTEM', `${hostUsername} さんが部屋を作成しました`);
    saveRoomsData(rooms);
    return { success: true, roomId: roomId };
  } finally {
    lock.releaseLock();
  }
}

function joinRoom(roomId, username) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false, message: "混雑しています。もう一度お試しください。" };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];

    if (!room) return { success: false, message: "部屋が存在しません" };
    if (room.status !== 'LOBBY' && !room.members.includes(username)) {
      return { success: false, message: "ゲーム中の部屋には入室できません" };
    }

    if (!room.members.includes(username)) {
      room.members.push(username);
      addLog(room, 'SYSTEM', `${username} さんが入室しました`);
      saveRoomsData(rooms);
    }

    return { success: true, room: room };
  } finally {
    lock.releaseLock();
  }
}

function getRoomDetails(roomId, username) {
  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];

    if (!room) return { success: false, message: "部屋が存在しません" };
    if (!room.members.includes(username)) {
      return { success: false, kicked: true, message: "部屋から退出させられました" };
    }

    const myInfo = room.players[username] || { isAlive: true, role: "" };
    const isDead = (myInfo.isAlive === false);

    // 霊界（死亡者）またはゲーム終了時は全員の役職を開示
    const players = room.members.map(name => {
      const p = room.players[name] || {};
      return {
        name: name,
        isAlive: p.isAlive !== false,
        role: (room.status === 'FINISHED' || isDead) ? p.role : null
      };
    });

    // チャットのアクセス権限フィルター
    const filteredLogs = (room.logs || []).filter(l => {
      if (room.status === 'FINISHED') return true; // 終了後は全ログ閲覧可能

      if (l.type === 'WOLF') {
        return myInfo.role === '人狼' || isDead;
      }
      if (l.type === 'GRAVE') {
        return isDead;
      }
      if (l.type === 'SOLILOQUY') {
        return l.sender === username;
      }
      if (l.type === 'PRIVATE') {
        return l.sender === username;
      }
      return true;
    });

    return {
      success: true,
      room: room,
      players: players,
      myInfo: myInfo,
      logs: filteredLogs
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

function updateRoomSettings(roomId, settings) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room || room.status !== 'LOBBY') return;

    room.dayTime = parseInt(settings.dayTime) || 4;
    room.voteTime = parseInt(settings.voteTime) || 1;
    room.nightTime = parseInt(settings.nightTime) || 1;
    room.tieRule = settings.tieRule || 'random';
    room.roles = settings.roles || room.roles;

    saveRoomsData(rooms);
  } finally {
    lock.releaseLock();
  }
}

function kickPlayer(roomId, targetName) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false, message: "処理に失敗しました" };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room || room.status !== 'LOBBY') return { success: false, message: "ロビー待機中のみキック可能です" };

    room.members = room.members.filter(m => m !== targetName);
    if (room.players && room.players[targetName]) {
      delete room.players[targetName];
    }
    addLog(room, 'SYSTEM', `${targetName} さんがキックされました`);

    saveRoomsData(rooms);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function leaveRoom(roomId, username) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room) return { success: true };

    room.members = room.members.filter(m => m !== username);
    if (room.players && room.players[username]) {
      delete room.players[username];
    }
    addLog(room, 'SYSTEM', `${username} さんが退出しました`);

    if (room.members.length === 0) {
      delete rooms[roomId];
    } else if (room.host === username) {
      room.host = room.members[0];
      addLog(room, 'SYSTEM', `${room.host} さんが新しい部屋主になりました`);
    }

    saveRoomsData(rooms);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function resetRoomToLobby(roomId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false, message: "処理中です" };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room) return { success: false, message: "部屋が存在しません" };

    room.status = 'LOBBY';
    room.day = 1;
    room.players = {};
    room.endTime = 0;
    addLog(room, 'SYSTEM', '=== 部屋が待機状態に戻されました ===');

    saveRoomsData(rooms);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// 3. チャット送信機能
// ==========================================
function sendChatMessage(roomId, username, message, chatType = 'AUTO') {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false, message: "送信が失敗しました" };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room) return { success: false };

    const p = room.players[username] || { isAlive: true, role: "" };
    let type = 'CHAT';

    // ゲーム終了後は全員全体チャット可
    if (room.status === 'FINISHED') {
      type = 'CHAT';
    } else if (chatType === 'SOLILOQUY') {
      type = 'SOLILOQUY';
    } else if (!p.isAlive) {
      type = 'GRAVE';
    } else if (room.status === 'NIGHT' || room.status === 'FIRST_NIGHT') {
      if (p.role === '人狼') {
        type = 'WOLF';
      } else {
        return { success: false, message: "夜間は独り言以外会話できません" };
      }
    } else {
      if (chatType === 'WOLF' && p.role === '人狼') {
        type = 'WOLF';
      } else {
        type = 'CHAT';
      }
    }

    addLog(room, type, message, username);
    saveRoomsData(rooms);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// 4. ゲーム進行＆人狼ロジック
// ==========================================
function startGame(roomId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false, message: "処理中です" };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room) return { success: false, message: "部屋が存在しません" };

    const members = room.members;
    const rolesObj = room.roles;

    let roleList = [];
    const roleKeys = ['villager', 'werewolf', 'seer', 'medium', 'bodyguard', 'madman', 'fox'];
    const roleMap = {
      villager: '村人', werewolf: '人狼', seer: '占い師',
      medium: '霊媒師', bodyguard: '狩人', madman: '狂人', fox: '妖狐'
    };

    roleKeys.forEach(k => {
      const count = rolesObj[k] || 0;
      for (let i = 0; i < count; i++) roleList.push(roleMap[k]);
    });

    if (roleList.length !== members.length) {
      return { success: false, message: `参加人数(${members.length}人)と役職合計(${roleList.length}人)が一致しません` };
    }

    for (let i = roleList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
    }

    room.players = {};
    members.forEach((m, idx) => {
      room.players[m] = {
        role: roleList[idx],
        isAlive: true,
        voteTarget: "",
        actionTarget: ""
      };
    });

    room.status = 'FIRST_NIGHT';
    room.day = 1;
    room.endTime = new Date().getTime() + (room.nightTime * 60 * 1000);

    addLog(room, 'SYSTEM', '=== ゲームを開始しました ===');
    addLog(room, 'SYSTEM', `1日目【初日夜】になりました。人狼は襲撃できません。(${room.nightTime}分)`);

    // 初日占い：人狼と妖狐以外を自動対象にする
    Object.keys(room.players).forEach(pName => {
      if (room.players[pName].role === '占い師') {
        const validTargets = Object.keys(room.players).filter(name =>
          name !== pName &&
          room.players[name].role !== '人狼' &&
          room.players[name].role !== '妖狐'
        );
        
        if (validTargets.length > 0) {
          const target = validTargets[Math.floor(Math.random() * validTargets.length)];
          addLog(room, 'PRIVATE', `1日目 占い結果：${target} さんは 【人間】 でした`, pName);
        }
      }
    });

    saveRoomsData(rooms);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function advancePhase(roomId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { success: false, message: "混雑しています" };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room) return { success: false };

    if (room.status === 'FIRST_NIGHT') {
      room.status = 'DAY';
      room.endTime = new Date().getTime() + (room.dayTime * 60 * 1000);
      addLog(room, 'SYSTEM', `=== 1日目の朝になりました ===`);
      addLog(room, 'SYSTEM', `【昼の議論】時間を開始します(${room.dayTime}分)`);

    } else if (room.status === 'DAY') {
      room.status = 'VOTE';
      room.endTime = new Date().getTime() + (room.voteTime * 60 * 1000);
      addLog(room, 'SYSTEM', `【投票フェーズ】追放したい対象を選択してください(${room.voteTime}分)`);

    } else if (room.status === 'VOTE') {
      resolveVote(room);
      if (checkWinCondition(room)) {
        saveRoomsData(rooms);
        return { success: true };
      }
      room.status = 'NIGHT';
      room.endTime = new Date().getTime() + (room.nightTime * 60 * 1000);
      addLog(room, 'SYSTEM', `${room.day}日目【夜の行動】能力者は対象を選択してください(${room.nightTime}分)`);

    } else if (room.status === 'NIGHT') {
      resolveNight(room);
      if (checkWinCondition(room)) {
        saveRoomsData(rooms);
        return { success: true };
      }
      room.day += 1;
      room.status = 'DAY';
      room.endTime = new Date().getTime() + (room.dayTime * 60 * 1000);
      addLog(room, 'SYSTEM', `=== ${room.day}日目の朝になりました ===`);
      addLog(room, 'SYSTEM', `【昼の議論】時間を開始します(${room.dayTime}分)`);
    }

    saveRoomsData(rooms);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function submitAction(roomId, username, target, actionType) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { success: false };

  try {
    const rooms = getRoomsData();
    const room = rooms[roomId];
    if (!room || !room.players[username]) return { success: false };

    const p = room.players[username];

    if (actionType === 'VOTE') {
      const isFirstVote = !p.voteTarget;
      p.voteTarget = target;

      let votedCount = 0;
      let totalAlive = 0;
      Object.keys(room.players).forEach(name => {
        if (room.players[name].isAlive) {
          totalAlive++;
          if (room.players[name].voteTarget) votedCount++;
        }
      });

      if (isFirstVote) {
        addLog(room, 'SYSTEM', `${username} さんが投票しました (${votedCount}/${totalAlive})`);
      } else {
        addLog(room, 'SYSTEM', `${username} さんが投票先を変更しました (${votedCount}/${totalAlive})`);
      }
    } else if (actionType === 'NIGHT') {
      p.actionTarget = target;
    }

    saveRoomsData(rooms);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function resolveVote(room) {
  const votes = {};
  let voteDetailsLog = "【投票内訳】\n";

  Object.keys(room.players).forEach(pName => {
    const p = room.players[pName];
    if (p.isAlive) {
      if (p.voteTarget) {
        votes[p.voteTarget] = (votes[p.voteTarget] || 0) + 1;
        voteDetailsLog += `・${pName} → ${p.voteTarget}\n`;
      } else {
        voteDetailsLog += `・${pName} → (未投票)\n`;
      }
    }
  });

  addLog(room, 'SYSTEM', voteDetailsLog.trim());

  let maxVotes = 0;
  let executed = [];
  for (let target in votes) {
    if (votes[target] > maxVotes) {
      maxVotes = votes[target];
      executed = [target];
    } else if (votes[target] === maxVotes) {
      executed.push(target);
    }
  }

  if (executed.length === 0) {
    addLog(room, 'SYSTEM', '誰も投票しなかったため、追放者はありませんでした');
  } else if (executed.length > 1) {
    if (room.tieRule === 'random') {
      const chosen = executed[Math.floor(Math.random() * executed.length)];
      room.players[chosen].isAlive = false;
      addLog(room, 'SYSTEM', `得票数が同数(${maxVotes}票)のため、抽選で ${chosen} さんが追放されました`);
    } else {
      addLog(room, 'SYSTEM', `得票数が同数(${maxVotes}票)のため、本日の追放はありませんでした`);
    }
  } else {
    const chosen = executed[0];
    room.players[chosen].isAlive = false;
    addLog(room, 'SYSTEM', `投票の結果(${maxVotes}票)、${chosen} さんが追放されました`);
  }

  Object.keys(room.players).forEach(pName => room.players[pName].voteTarget = "");
}

function resolveNight(room) {
  let wolfTarget = null;
  let guardTarget = null;

  Object.keys(room.players).forEach(pName => {
    const p = room.players[pName];
    if (!p.isAlive) return;

    if (p.role === '人狼' && p.actionTarget) wolfTarget = p.actionTarget;
    if (p.role === '狩人' && p.actionTarget) guardTarget = p.actionTarget;

    if (p.role === '占い師' && p.actionTarget) {
      const targetP = room.players[p.actionTarget];
      const resultText = targetP ? (targetP.role === '人狼' ? '【人狼】' : '【人間】') : '不明';
      addLog(room, 'PRIVATE', `${room.day}日目 占い結果：${p.actionTarget} さんは ${resultText} でした`, pName);

      if (targetP && targetP.role === '妖狐') {
        targetP.isAlive = false;
      }
    }
  });

  if (wolfTarget) {
    if (wolfTarget === guardTarget) {
      addLog(room, 'SYSTEM', '昨夜は誰も死にませんでした（護衛成功）');
    } else {
      const victim = room.players[wolfTarget];
      if (victim && victim.role !== '妖狐') {
        victim.isAlive = false;
        addLog(room, 'SYSTEM', `無惨にも ${wolfTarget} さんが死体となって発見されました`);
      } else {
        addLog(room, 'SYSTEM', '昨夜は誰も死にませんでした');
      }
    }
  } else {
    addLog(room, 'SYSTEM', '昨夜は誰も死にませんでした');
  }

  Object.keys(room.players).forEach(pName => room.players[pName].actionTarget = "");
}

function checkWinCondition(room) {
  let wolfCount = 0;
  let humanCount = 0;
  let foxCount = 0;

  Object.keys(room.players).forEach(pName => {
    const p = room.players[pName];
    if (p.isAlive) {
      if (p.role === '人狼') wolfCount++;
      else if (p.role === '妖狐') foxCount++;
      else humanCount++; // 村人・占い・霊媒・狩人・狂人は人間カウント
    }
  });

  let winner = null;

  if (wolfCount === 0) {
    winner = (foxCount > 0) ? '妖狐陣営' : '村人陣営';
  } else if (wolfCount >= humanCount) {
    winner = (foxCount > 0) ? '妖狐陣営' : '人狼陣営';
  }

  if (winner) {
    room.status = 'FINISHED';
    addLog(room, 'SYSTEM', `=== ゲーム終了！【${winner}】の勝利です！ ===`);

    let resultMsg = "【役職一覧】\n";
    Object.keys(room.players).forEach(pName => {
      resultMsg += `${pName}: ${room.players[pName].role}\n`;
    });
    addLog(room, 'SYSTEM', resultMsg);
    return true;
  }

  return false;
}
