// static/script.js
(() => {
  const socket = io(); // connect to same host
  // expose the same socket globally so other modules (conference.js) can reuse it
  window.socket = socket;

  // re-introduce on every socket connect (covers reconnects)
  socket.on('connect', () => {
    console.log('socket connected -> sending introduce if profile exists', socket.id);
    if (me && me.id) {
      // emit introduce so server updates connected_users and broadcasts presence_update
      socket.emit('introduce', { userId: me.id, name: me.name, password: me.password });
    }
  });

  // DOM elements
  const firstOverlay = document.getElementById('firstOverlay');
  const ftStart = document.getElementById('ftStart');
  const ftName = document.getElementById('ftName');
  const ftId = document.getElementById('ftId');

  const myNameEl = document.getElementById('myName');
  const myIdEl = document.getElementById('myId');
  const contactsList = document.getElementById('contactsList');
  const contactTopName = document.getElementById('contactTopName');
  const contactTopId = document.getElementById('contactTopId');
  const messagesWindow = document.getElementById('messagesWindow');

  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');

  const btnAddContact = document.getElementById('btnAddContact');
  const btnCreateGroup = document.getElementById('btnCreateGroup');

  // modal
  const modalOverlay = document.getElementById('modalOverlay');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalOk = document.getElementById('modalOk');
  const modalCancel = document.getElementById('modalCancel');

  // localStorage keys
  const KEY_PROFILE = 'synappz_profile';
  const KEY_CONTACTS = 'synappz_contacts';
  const KEY_GROUPS = 'synappz_groups';
  const KEY_MESSAGES = 'synappz_messages'; // object keyed by chat key
  const KEY_LAST_READ = 'synappz_last_read'; // chatKey -> ts of last read

  const contextMenu = document.getElementById('contextMenu');
  let currentContextTarget = null;


  let me = null;
  let contacts = []; // {id, name, type: 'person'|'group'}
  let groups = {};   // groupId -> {groupId, name, members}
  let messages = {}; // chatKey -> [messages]
  let lastRead = {}; // chatKey -> ts
  let onlineStatuses = {}; // userId -> boolean
  let activeChat = null; // { type:'direct'|'group', id: <contactId> } ; chatKey generation rule below

document.addEventListener('click', () => contextMenu.classList.add('hidden'));

  // helper chat key generators
  function chatKeyDirect(a,b){
    const [x,y] = [a,b].sort();
    return `chat:${x}__${y}`;
  }
  function chatKeyGroup(gid){
    return `group:${gid}`;
  }

  function openAICompose(){
    const ov = document.getElementById('aiComposeOverlay');
    if(!ov) return;
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden','false');
    // focus input after showing
    const input = document.getElementById('aiComposeInput');
    setTimeout(()=> input && input.focus(), 120);
  }
  window.openAICompose = openAICompose;

  // load local data
  function loadLocal(){
    const p = localStorage.getItem(KEY_PROFILE);
    if(p) me = JSON.parse(p);
    const c = localStorage.getItem(KEY_CONTACTS);
    contacts = c ? JSON.parse(c) : [];
    const g = localStorage.getItem(KEY_GROUPS);
    groups = g ? JSON.parse(g) : {};
    const m = localStorage.getItem(KEY_MESSAGES);
    messages = m ? JSON.parse(m) : {};
    const lr = localStorage.getItem(KEY_LAST_READ);
    lastRead = lr ? JSON.parse(lr) : {};
  }
  function saveLocal(){
    localStorage.setItem(KEY_PROFILE, JSON.stringify(me));
    localStorage.setItem(KEY_CONTACTS, JSON.stringify(contacts));
    localStorage.setItem(KEY_GROUPS, JSON.stringify(groups));
    localStorage.setItem(KEY_MESSAGES, JSON.stringify(messages));
    localStorage.setItem(KEY_LAST_READ, JSON.stringify(lastRead));
  }

  // determine last message ts for a contact/group
  function lastMessageTsForContact(c){
    const key = c.type === 'group' ? chatKeyGroup(c.id) : chatKeyDirect(me.id, c.id);
    const list = messages[key] || [];
    return list.length ? list[list.length - 1].ts : 0;
  }

  // sort contacts in-place by latest message timestamp (desc)
  function sortContactsByLatestMessage(){
    contacts.sort((a,b) => {
      const ta = lastMessageTsForContact(a) || 0;
      const tb = lastMessageTsForContact(b) || 0;
      // if both zero, keep existing order (stable sort behavior)
      return tb - ta;
    });
  }

  // update chat header to show online label if peer online
  function updateChatHeaderPresence() {
  if (!activeChat) return;
  
  if (activeChat.type === 'group') {
    const group = groups[activeChat.id];
    if (!group) return;
    
    // Count online members (including self if online)
    const onlineCount = group.members.filter(id => onlineStatuses[id]).length;
    
    contactTopId.innerHTML = `group: ${activeChat.id} ${
      onlineCount > 0 ? `<span class="online">${onlineCount} online</span>` : ''
    }`;
    return;
  }

  // Direct chat presence (existing code)
  const id = activeChat.id;
  const online = onlineStatuses[id];
  contactTopId.innerHTML = id + (online ? ` <span class="online">online</span>` : '');
}

  // load saved state
  loadLocal();

  function showFirstIfNeeded(){
    if(!me || !me.id){
      firstOverlay.classList.remove('hidden');
      return true;
    } else {
      firstOverlay.classList.add('hidden');
      return false;
    }
  }

  function setProfileUI(){
    myNameEl.textContent = me.name || '—';
    myIdEl.textContent = me.id || '—';
    // tell server who we are (include password if available)
    socket.emit('introduce', { userId: me.id, name: me.name, password: me.password });
  }

  function handleContactMenu(action){
  const c = currentContextTarget;
  if(!c) return;

  // Rename (local)
  if(action === 'Rename'){
    const currentName = c.name || c.id || '';
    openModal('Rename', `
      <div style="display:flex;flex-direction:column;gap:8px">
        <input id="renameInput" value="${escapeHtml(currentName)}" />
      </div>
    `, () => {
      const newName = document.getElementById('renameInput').value.trim();
      if(!newName) { alert('Name cannot be empty'); return; }

      // update contacts list entry
      contacts = contacts.map(x => x.id === c.id ? Object.assign({}, x, { name: newName }) : x);

      // if group, also update groups map
      if(c.type === 'group' && groups[c.id]) {
        groups[c.id].name = newName;
      }

      saveLocal();
      renderContacts();

      // if currently open chat matches renamed contact/group, update header
      if(activeChat && activeChat.id === c.id){
        if(activeChat.type === 'group'){
          contactTopName.textContent = groups[c.id] ? groups[c.id].name : newName;
        } else {
          contactTopName.textContent = newName;
        }
      }

      closeModal();
    });
    return;
  }

  // Delete contact (with confirmation)
  if(action === 'Delete contact'){
    openModal('Confirm delete', `<div>Are you sure you want to delete contact <strong>${escapeHtml(c.name || c.id)}</strong> ?</div>`, () => {
      contacts = contacts.filter(x => x.id !== c.id || x.type !== 'person');
      // if this contact was active, clear chat view
      if(activeChat && activeChat.type === 'direct' && activeChat.id === c.id){
        activeChat = null;
        contactTopName.textContent = 'Select a contact';
        contactTopId.textContent = '—';
        messagesWindow.innerHTML = '';
      }
      saveLocal();
      renderContacts();
      closeModal();
    });
    return;
  }

  // Leave group (with confirmation)
  if(action === 'Leave group'){
    const gid = c.id;
    openModal('Confirm leave', `<div>Leave group <strong>${escapeHtml(c.name || gid)}</strong>? You will be removed locally.</div>`, () => {
      const g = groups[gid];
      // remove group locally
      delete groups[gid];
      contacts = contacts.filter(x => !(x.id === gid && x.type === 'group'));

      // add a system leave message to the group's chat (local only, server already handled elsewhere via event)
      const leaveMsg = {
        fromId: 'system', fromName: '', toId: gid, type: 'group',
        text: `<i>${me.id} left the group</i>`,
        ts: Date.now()
      };
      const key = chatKeyGroup(gid);
      messages[key] = messages[key] || [];
      messages[key].push(leaveMsg);

      socket.emit('group_leave', { groupId: gid, userId: me.id });

      // if active chat was this group, clear it
      if(activeChat && activeChat.type === 'group' && activeChat.id === gid){
        activeChat = null;
        contactTopName.textContent = 'Select a contact';
        contactTopId.textContent = '—';
        messagesWindow.innerHTML = '';
      }

      saveLocal();
      renderContacts();
      closeModal();
    });
    return;
  }
}


  function renderContacts(filter=''){
    // sort contacts by recent activity
    sortContactsByLatestMessage();

    contactsList.innerHTML = '';
    const list = contacts.filter(c => (c.name || c.id).toLowerCase().includes(filter.toLowerCase()) || c.id.toLowerCase().includes(filter.toLowerCase()));
    list.forEach(c => {
        const div = document.createElement('div');
        div.className = 'contactItem';
        div.dataset.id = c.id;
        div.dataset.type = c.type || 'person';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = (c.name || c.id || 'U').slice(0,2).toUpperCase();

        const meta = document.createElement('div');
        meta.className = 'contactMeta';
        const nameEl = document.createElement('div');
        nameEl.className = 'name';
        nameEl.textContent = c.name || c.id;
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = c.type === 'group' ? `Group • ${c.id}` : c.id;

        meta.appendChild(nameEl);
        meta.appendChild(sub);

        div.appendChild(avatar);
        div.appendChild(meta);

        // determine unread state for this contact
        const key = c.type === 'group' ? chatKeyGroup(c.id) : chatKeyDirect(me.id, c.id);
        const lastMsgTs = (messages[key] && messages[key].length) ? messages[key][messages[key].length - 1].ts : 0;
        const lastReadTs = lastRead[key] || 0;
        const hasUnread = lastMsgTs > lastReadTs;

        if(hasUnread){
          const dot = document.createElement('div');
          dot.className = 'unread-dot';
          // append dot at end so it's on right side
          div.appendChild(dot);
        }

        // Add both the chat open handler and mobile z-index handler
        div.addEventListener('click', () => {
            openChat(c.type === 'group' ? 'group' : 'direct', c.id);
            // Handle mobile view
            const main = document.getElementById('main');
            if (window.innerWidth <= 768) { // Only adjust z-index on mobile
                main.style.zIndex = '2';
            }
        });

        contactsList.appendChild(div);

        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            currentContextTarget = c;
            // offer Rename for both; group shows Leave, person shows Delete
            const opts = c.type === 'group' ? ['Rename', 'Leave group'] : ['Rename', 'Delete contact'];
            showContextMenu(e.pageX, e.pageY, opts, handleContactMenu);
        });
    });
  }

  function openChat(type, id){
    activeChat = { type, id };
    if(type === 'group'){
      contactTopName.textContent = groups[id] ? groups[id].name : id;
      contactTopId.textContent = `group: ${id}`;
    } else {
      // find contact to show name
      const c = contacts.find(x => x.id === id);
      contactTopName.textContent = (c && c.name) ? c.name : id;
      // contactTopId will be updated by updateChatHeaderPresence()
      contactTopId.textContent = id;
    }
    renderMessages();

    // mark as read: set lastRead for this chat to latest message ts (or now)
    const key = type === 'group' ? chatKeyGroup(id) : chatKeyDirect(me.id, id);
    const list = messages[key] || [];
    if(list.length){
      lastRead[key] = list[list.length - 1].ts;
    } else {
      lastRead[key] = Date.now();
    }
    saveLocal();
    renderContacts();
    updateChatHeaderPresence();
  }

function openForwardModal(text, image) { // Add image parameter
  const listHtml = contacts.map(c =>
    `<label><input type="checkbox" value="${c.id}" data-type="${c.type||'person'}"> ${c.name||c.id}</label>`
  ).join('<br>');
  openModal('Forward message', `<div>${listHtml}</div>`, () => {
    const checked = Array.from(document.querySelectorAll('#modalBody input:checked'));
    if (!checked.length) {
      alert('Select at least one recipient');
      return;
    }

    let renderedCurrent = false;

    checked.forEach(chk => {
      const id = chk.value;
      const type = chk.dataset.type;
      const now = Date.now();
      const payload = {
        fromId: me.id,
        fromName: me.name || me.id,
        toId: id,
        type,
        text,
        image, // Add image if present
        ts: now
      };
      const key = type === 'group' ? chatKeyGroup(id) : chatKeyDirect(me.id, id);
      messages[key] = messages[key] || [];
      messages[key].push(payload);

      // If forwarding into currently open chat, update lastRead and mark for immediate render
      if (activeChat) {
        const sameChat =
          (activeChat.type === 'group' && type === 'group' && activeChat.id === id) ||
          (activeChat.type === 'direct' && type !== 'group' && activeChat.id === id);
        if (sameChat) {
          lastRead[key] = payload.ts;
          renderedCurrent = true;
        }
      }

      socket.emit('send_message', payload);
    });

    saveLocal();

    // Immediate UI update if any forwarded into active chat
    if (renderedCurrent) {
      renderMessages();
    }
    // Always refresh contacts list ordering/unread markers
    sortContactsByLatestMessage();
    renderContacts();

    closeModal();
  });
}

// Update the message menu handler to pass image when forwarding
function handleMessageMenu(action) {
  const { message, key } = currentContextTarget;
  switch(action){
    case 'Copy':
      navigator.clipboard.writeText(message.text);
      break;
    case 'Forward':
      openForwardModal(message.text, message.image); // Pass the image
      break;
    case 'Edit':
      openEditModal(message, key);
      break;
    case 'Delete':
      deleteMessageForAll(message, key);
      break;
  }
}


  function showContextMenu(x, y, options, callback) {
  contextMenu.innerHTML = '';
  options.forEach(opt => {
    const div = document.createElement('div');
    div.textContent = opt;
    div.addEventListener('click', () => {
      contextMenu.classList.add('hidden');
      callback(opt);
    });
    contextMenu.appendChild(div);
  });
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.remove('hidden');
}

function renderMessages() {
  messagesWindow.innerHTML = '';
  if (!activeChat) return;

  const key =
    activeChat.type === 'group'
      ? chatKeyGroup(activeChat.id)
      : chatKeyDirect(me.id, activeChat.id);

  const list = messages[key] || [];

  list.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'msgRow' + (m.fromId === me.id ? ' me' : '');
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = (m.fromName || m.fromId || '?')[0].toUpperCase();
    
    const bubble = document.createElement('div');
    bubble.className = 'msgBubble';

    // If message is marked deleted, render a single "deleted" placeholder (no image)
    if (m.deleted) {
      bubble.textContent = 'message deleted';
      bubble.classList.add('msgDeleted');
      const meta = document.createElement('div');
      meta.className = 'msgMeta';
      const nameLabel = (m.fromName || m.fromId || '');
      meta.textContent = (nameLabel ? (nameLabel + ' • ') : '') + (m.ts ? new Date(m.ts).toLocaleTimeString() : '');
      bubble.appendChild(meta);

      // attach context menu for deleted messages as well (owner can still copy/forward if needed)
      bubble.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        currentContextTarget = { message: m, key };
        const opts = (m.fromId === me.id) ? ['Copy', 'Forward', 'Delete'] : ['Copy', 'Forward'];
        showContextMenu(e.pageX, e.pageY, opts, handleMessageMenu);
      });

      row.appendChild(avatar);
      row.appendChild(bubble);
      messagesWindow.appendChild(row);
      return; // skip regular rendering
    }
    
    // Handle image messages
    if (m.image) {
      const img = document.createElement('img');
      img.src = m.image;
      img.onload = () => messagesWindow.scrollTop = messagesWindow.scrollHeight;

      // append image (no per-image document listeners here)
      bubble.appendChild(img);

      if (m.text) {
        bubble.classList.add('with-text');
        const textDiv = document.createElement('div');
        textDiv.textContent = m.text;
        bubble.appendChild(textDiv);
      }

      // Add metadata for image messages (name and timestamp)
      const meta = document.createElement('div');
      meta.className = 'msgMeta';
      const nameLabel = (m.fromName || m.fromId || '');
      meta.textContent = (nameLabel ? (nameLabel + ' • ') : '') + new Date(m.ts).toLocaleTimeString();
      bubble.appendChild(meta);
    } else {
      // decide rendering path: system messages that contain HTML tags
      if (m.text && /<[^>]+>/.test(m.text)) {
        bubble.innerHTML = m.text; // preserve existing system HTML (e.g. <i>...</i>)
        bubble.classList.add('system-message');
      } else {
        // formatted safe HTML for regular / AI messages
        bubble.innerHTML = formatDisplayText(m.text || '');

        // add meta (time) for non-system messages
        const meta = document.createElement('div');
        meta.className = 'msgMeta';
        const nameLabel = (m.fromName || m.fromId || '');
        meta.textContent = (nameLabel ? (nameLabel + ' • ') : '') + new Date(m.ts).toLocaleTimeString();
        bubble.appendChild(meta);
      }
    }
    
    // add message context menu (right click) - owner gets edit/delete
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // set currentContextTarget so existing handlers can act
      currentContextTarget = { message: m, key };
      const opts = (m.fromId === me.id) ? ['Copy', 'Forward', 'Edit', 'Delete'] : ['Copy', 'Forward'];
      showContextMenu(e.pageX, e.pageY, opts, handleMessageMenu);
    });

    row.appendChild(avatar);
    row.appendChild(bubble);
    messagesWindow.appendChild(row);
  });

  messagesWindow.scrollTop = messagesWindow.scrollHeight;
  updateChatHeaderPresence();
}



  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }

  // format message text for display:
  // - escape user HTML
  // - convert **bold** -> <b>bold</b>
  // - replace remaining single '*' -> ●
  // NOTE: if message already contains raw HTML tags (e.g. system messages with <i>...</i>),
  // we render it as-is to preserve intended markup.
  function formatDisplayText(text){
    if(!text) return '';
    // detect raw HTML tags (simple heuristic)
    const hasHtmlTag = /<[^>]+>/.test(text);
    if(hasHtmlTag){
      return text; // render system HTML (already trusted elsewhere)
    }

    // escape HTML first to avoid XSS, then apply our simple markdown-like transforms
    const esc = escapeHtml(text);
    // bold: **text** -> <b>text</b> (non-greedy)
    let out = esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // replace any remaining single '*' with a bullet ●
    return out;
  }

  // adding contacts
  function showAddContactModal(){
  openModal('Add contact by ID', `
    <div style="display:flex;flex-direction:column;gap:8px">
      <input id="newContactId" placeholder="Contact ID (e.g. bob123)" />
      <input id="newContactName" placeholder="Optional display name" />
    </div>
  `, () => {
    const id = document.getElementById('newContactId').value.trim();
    const name = document.getElementById('newContactName').value.trim();
    if(!id) return alert('Provide an ID');
    if(contacts.some(c => c.id === id && c.type === 'person')) {
      alert('Contact already exists');
      closeModal();
      return;
    }
    // Ask server if user exists, including our info for reciprocation
    socket.emit('check_user_exists', {
      targetId: id,
      sourceId: me.id,
      sourceName: me.name
    });
    socket.once('user_exists_result', exists => {
      if(!exists) return alert('No such user exists!');
      contacts.push({ id, name: name || id, type: 'person' });
      saveLocal();
      // re-sort and render
      renderContacts();
      closeModal();
    });
  });
}

  // group creation
  function showCreateGroupModal(){
    openModal('Create a group', `
      <div style="display:flex;flex-direction:column;gap:8px">
        <input id="groupId" placeholder="Group ID (unique, e.g. friends2025)" />
        <input id="groupName" placeholder="Group name (e.g. Besties)" />
        <textarea id="groupMembers" placeholder="Member IDs, comma separated (include yourself if you want)"></textarea>
      </div>
    `, () => {
      const gid = document.getElementById('groupId').value.trim();
      const gname = document.getElementById('groupName').value.trim();
      const mems = document.getElementById('groupMembers').value.split(',').map(x=>x.trim()).filter(Boolean);
      if(!gid || !gname) { alert('group id and name required'); return; }
      if(groups[gid]) { alert('group id already exists'); return; }
      // ensure creator included if not already
      if(!mems.includes(me.id)) mems.push(me.id);
      groups[gid] = { groupId: gid, name: gname, members: mems, creator: me.id };
      // add to contacts list as group
      contacts.unshift({ id: gid, name: gname, type: 'group' });
      saveLocal();
      // notify server about group (server will persist and broadcast)
      socket.emit('create_group', { groupId: gid, name: gname, members: mems, creatorId: me.id });
      renderContacts();
      closeModal();
    });
  }

  // modal helpers
  function openModal(title, bodyHtml, okCallback){
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHtml;
    modalOverlay.classList.remove('hidden');
    modalOk.onclick = () => { okCallback(); };
    modalCancel.onclick = closeModal;
  }
  function closeModal(){
    modalOverlay.classList.add('hidden');
    modalBody.innerHTML = '';
    modalOk.onclick = null;
  }

  // send message
  function sendMessage(){
    if(!activeChat) return alert('Select a contact first');
    const text = messageInput.value.trim();
    if(!text) return;
    const now = Date.now();
    const payload = {
      fromId: me.id,
      fromName: me.name,
      toId: activeChat.id,
      type: activeChat.type === 'group' ? 'group' : 'direct',
      text,
      ts: now
    };
    // store locally
    const key = payload.type === 'group' ? chatKeyGroup(payload.toId) : chatKeyDirect(payload.fromId, payload.toId);
    messages[key] = messages[key] || [];
    messages[key].push(payload);
    // mark as read for sender view
    lastRead[key] = now;
    saveLocal();
    renderMessages();
    sendBtn.classList.remove('sending');
    // send to server for delivery & persistence
    socket.emit('send_message', payload);
    messageInput.value = '';
    messageInput.style.height = 'auto';
  }

  // on receiving message from Socket.IO
  // replaced incoming message handler to rely on renderMessages (remove stray DOM bubble)
socket.on('message', (m) => {
  if (m.fromId === me.id) return;
  const key = m.type === 'group' ? chatKeyGroup(m.toId) : chatKeyDirect(m.fromId, m.toId);
  messages[key] = messages[key] || [];
  messages[key].push(m);
  saveLocal();

  // fallback: if we receive a message from someone we considered offline, mark them online
  if (m.fromId && !onlineStatuses[m.fromId]) {
    onlineStatuses[m.fromId] = true;
    window.onlineStatuses = onlineStatuses;
    try { renderContacts(); } catch(e) {}
    try { updateChatHeaderPresence(); } catch(e) {}
    try { updateCallButtonVisibility(); } catch(e) {}
  }

   if (activeChat) {
     const match = (activeChat.type === 'group' && m.type === 'group' && activeChat.id === m.toId)
       || (activeChat.type === 'direct' && m.type !== 'group' && ((activeChat.id === m.fromId) || (activeChat.id === m.toId)));
     if (match) {
       lastRead[key] = (messages[key] && messages[key].length) ? messages[key][messages[key].length - 1].ts : Date.now();
       saveLocal();
       renderMessages();
     }
   }

  sortContactsByLatestMessage();
  renderContacts();

  if (document.hidden) {
    try {
      if (Notification && Notification.permission === "granted") {
        new Notification(m.fromName || m.fromId, { body: m.text || 'Image' });
      }
    } catch (e) {}
  }
});

  socket.on('group_created', (g) => {
    // add to local groups and contacts
    groups[g.groupId] = g;
    if(!contacts.some(c => c.id === g.groupId && c.type === 'group')){
      contacts.unshift({ id: g.groupId, name: g.name, type: 'group' });
    }
    saveLocal();
    renderContacts();
  });

  socket.on("message_deleted", (data) => {
  const { key, ts } = data;
  if (!messages[key]) return;

  // find and mark deleted message
  const msg = messages[key].find(m => m.ts === ts);
  if (msg) {
    msg.text = "message deleted";
    msg.deleted = true;
    if ('image' in msg) delete msg.image; // remove image payload
    saveLocal();

    // refresh UI if this chat is open
    if (activeChat) {
      const isSameChat =
        (activeChat.type === "group" && key === chatKeyGroup(activeChat.id)) ||
        (activeChat.type === "direct" && key === chatKeyDirect(me.id, activeChat.id));
      if (isSameChat) renderMessages();
    }
  }
});

// --- EDIT / DELETE helpers (client) ---
function openEditModal(message, key){
  // reuse existing openModal; show textarea with current text
  openModal('Edit message', `
    <div style="display:flex;flex-direction:column;gap:8px">
      <textarea id="editMsgInput" style="width:100%;height:120px">${escapeHtml(message.text || '')}</textarea>
    </div>
  `, () => {
    const newText = document.getElementById('editMsgInput').value.trim();
    if(!newText) { alert('Message cannot be empty'); return; }

    // optimistic local update
    const list = messages[key] || [];
    const msg = list.find(m => m.ts === message.ts);
    if(msg){
      msg.text = newText + ' (edited)';
      saveLocal();
      if(activeChat){
        const same = (activeChat.type === 'group' && key === chatKeyGroup(activeChat.id)) ||
                     (activeChat.type === 'direct' && key === chatKeyDirect(me.id, activeChat.id));
        if(same) renderMessages();
      }
    }

    // tell server to persist & broadcast
    socket.emit('edit_message', { key, ts: message.ts, newText });
    closeModal();
  });
}

function deleteMessageForAll(message, key){
  if(!confirm('Delete this message for everyone?')) return;
  // optimistic local deletion mark
  const list = messages[key] || [];
  const msg = list.find(m => m.ts === message.ts);
  if(msg){
    msg.text = 'message deleted';
    msg.deleted = true;
    if('image' in msg) delete msg.image;
    saveLocal();
    if(activeChat){
      const same = (activeChat.type === 'group' && key === chatKeyGroup(activeChat.id)) ||
                   (activeChat.type === 'direct' && key === chatKeyDirect(me.id, activeChat.id));
      if(same) renderMessages();
    }
  }
  socket.emit('delete_message', { key, ts: message.ts });
}

// listen for edits from server and update local store/UI
socket.on('message_edited', (data) => {
  const { key, ts, newText } = data || {};
  if(!key || !ts) return;
  if(!messages[key]) return;
  const msg = messages[key].find(m => m.ts === ts);
  if(msg){
    msg.text = (newText || '') + ' (edited)';
    saveLocal();
    if(activeChat){
      const same = (activeChat.type === 'group' && key === chatKeyGroup(activeChat.id)) ||
                   (activeChat.type === 'direct' && key === chatKeyDirect(me.id, activeChat.id));
      if(same) renderMessages();
    }
  }
});


  // presence updates from server
  socket.on('presence_init', (onlineIds) => {
    onlineStatuses = {};
    (onlineIds || []).forEach(id => onlineStatuses[id] = true);
    window.onlineStatuses = onlineStatuses; // Keep global in sync
    // refresh UI
    try { renderContacts(); } catch(e) {}
    try { updateChatHeaderPresence(); } catch(e) {}
    try { updateCallButtonVisibility(); } catch(e) {}
 });

  socket.on('presence_update', data => {
     const { id, online } = data;
     onlineStatuses[id] = online;
     window.onlineStatuses = onlineStatuses; // Keep global in sync
    // refresh UI
    try { renderContacts(); } catch(e) {}
    try { updateChatHeaderPresence(); } catch(e) {}
    try { updateCallButtonVisibility(); } catch(e) {}
 });
 
 // server may push reciprocal contact additions (immediate if online, or upon login if pending)
 socket.on('contact_added', (contact) => {
   if(!contact || !contact.id) return;
   if(!contacts.some(c => c.id === contact.id && c.type === 'person')){
     contacts.push({ id: contact.id, name: contact.name || contact.id, type: 'person' });
     saveLocal();
     sortContactsByLatestMessage();
     renderContacts();
   }
 });


  // first-run setup handler
  ftStart.addEventListener('click', () => {
  const name = ftName.value.trim();
  const id = ftId.value.trim();
  if(!name || !id) return alert('Provide name and id');
  if(!/^[a-zA-Z0-9_-]+$/.test(id)) return alert('ID can only contain letters, numbers, _ and -');

  // clear previous error indicator
  const prev = document.getElementById('ftError');
  if(prev) prev.remove();

  // generate password (do NOT persist to localStorage until server confirms)
  function generatePassword(len = 24){
    const array = new Uint8Array(len);
    window.crypto.getRandomValues(array);
    return Array.from(array).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }
  const password = generatePassword(16);

  // temporary profile (don't save yet)
  me = { name, id, password };

  // wait for server confirmation
  socket.once('introduce_result', (res) => {
    if(res && res.ok){
      // only persist and update UI after server accepted the id
      contacts = contacts || [];
      saveLocal();
      setProfileUI();
      firstOverlay.classList.add('hidden');
      renderContacts();
    } else {
      // show error (userid exists or other reason)
      const err = document.createElement('div');
      err.id = 'ftError';
      err.style.color = 'red';
      err.style.marginTop = '8px';
      err.textContent = (res && res.reason === 'exists') ? 'User ID already exists. Please choose another.' : 'Could not create account. Try another ID.';
      const card = firstOverlay.querySelector('.card');
      card.appendChild(err);
      // clear me so UI doesn't think we're logged in
      me = null;
    }
  });

  // emit introduce and let server reply with introduce_result
  socket.emit('introduce', { userId: id, name: name, password: password });
});

  // init UI events
  btnAddContact.addEventListener('click', showAddContactModal);
  btnCreateGroup.addEventListener('click', showCreateGroupModal);
  sendBtn.addEventListener('click', sendMessage);
  
  // helper to detect touch/mobile devices
  function isTouchDevice(){ return ('ontouchstart' in window) || navigator.maxTouchPoints > 0; }
  
  // auto-resize textarea up to max height, then enable scrollbar
  function autoResize(){ 
    const maxH = 140; // px
    messageInput.style.height = 'auto';
    const sh = messageInput.scrollHeight;
    const newH = Math.min(sh, maxH);
    messageInput.style.height = newH + 'px';
    messageInput.style.overflowY = (sh > maxH) ? 'auto' : 'hidden';
  }

  // expose for other modules (AI composer module) so setting value can trigger resize
  window.autoResize = autoResize;

  // key handling:
  // - Desktop: Enter = send, Shift+Enter = newline
  // - Touch/mobile: Enter inserts newline (since soft keyboards usually provide newline)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const touch = isTouchDevice();
    if (touch) {
      // allow newline on mobile / touch keyboards
      // let the input event/autoResize handle the height change
      return;
    }
    // Desktop
    if (e.shiftKey) {
      // insert newline (browser does by default); ensure resize after
      setTimeout(autoResize, 0);
      return;
    }
    // Enter alone -> send
    e.preventDefault();
    sendMessage();
  });

  // resize while typing
  messageInput.addEventListener('input', autoResize);
  // ensure initial height
  setTimeout(autoResize, 0);

  // search
  document.getElementById('searchInput').addEventListener('input', (e) => { renderContacts(e.target.value) });

  // try to request notification permission
  if("Notification" in window && Notification.permission !== "granted"){
    Notification.requestPermission().then(()=>{});
  }

  // on page load:
  if(!showFirstIfNeeded()){
    setProfileUI();
    renderContacts();
    // keep default "no chat selected" state on load
    activeChat = null;
    contactTopName.textContent = 'Select a contact';
    contactTopId.textContent = '—';
    messagesWindow.innerHTML = '';
    // ensure header/presence and call-button reflect "no active chat"
    try { updateChatHeaderPresence(); } catch(e) {}
    try { updateCallButtonVisibility(); } catch(e) {}
  }

  // utility: allow adding a contact quickly via prompt if user presses "ctrl b" (handy)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'b' && (e.ctrlKey || e.metaKey)) {
      showAddContactModal();
      e.preventDefault();
    }
  });

  // touch screen right click support (long press)
  (function enableLongPressAsRightClick() {
  let touchTimer = null;
  let touchStartX = 0, touchStartY = 0;

  window.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return; // ignore multi-touch
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;

    // start timer — long press = right click
    touchTimer = setTimeout(() => {
      const simulatedEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: touchStartX,
        clientY: touchStartY,
        button: 2 // right button
      });
      e.target.dispatchEvent(simulatedEvent);
    }, 500); // hold duration (ms)
  }, { passive: true });

  // cancel if user moves or lifts before timeout
  ['touchend', 'touchcancel', 'touchmove'].forEach(type => {
    window.addEventListener(type, () => clearTimeout(touchTimer), { passive: true });
  });

  // prevent default iOS text selection / callout
  document.addEventListener('contextmenu', e => {
    if (e.pointerType === 'touch' || 'ontouchstart' in window) {
      e.preventDefault();
    }
  });
})();

const returnBtn = document.getElementById('return');

returnBtn.addEventListener('click', () => {
    const main = document.getElementById('main');
    if (window.innerWidth <= 768) {
        main.style.zIndex = '-1';

        // Reset chat view to default "no contact selected" state on small screens
        activeChat = null;
        contactTopName.textContent = 'Select a contact';
        contactTopId.textContent = '—';
        messagesWindow.innerHTML = '';

        // Re-render contacts so unread-dot states are correct
        renderContacts();
    }
});

const mediaBtn = document.getElementById('mediaBtn');
const mediaMenu = document.getElementById('mediaMenu');
const imageUpload = document.getElementById('imageUpload');
const cameraCapture = document.getElementById('cameraCapture');

function handleImageUpload(file) {
  // Size validation
  if (file.size > 5 * 1024 * 1024) { // 5MB limit
    alert('Image too large. Please choose an image under 5MB.');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    const imageData = e.target.result;
    
    // Basic image validation
    if (!imageData.startsWith('data:image/')) {
      alert('Invalid image file');
      return;
    }

    // Compress image before sending
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Calculate new dimensions (max 1200px width/height)
      let width = img.width;
      let height = img.height;
      const maxSize = 1200;
      
      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = (height / width) * maxSize;
          width = maxSize;
        } else {
          width = (width / height) * maxSize;
          height = maxSize;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      
      // Draw and compress
      ctx.drawImage(img, 0, 0, width, height);
      const compressedImage = canvas.toDataURL('image/jpeg', 0.7);
      
      sendMessageWithImage(compressedImage);
    };
    img.src = imageData;
  };
  reader.readAsDataURL(file);
}

function sendMessageWithImage(imageData) {
  if (!activeChat) return alert('Select a contact first');
  
  const text = messageInput.value.trim();
  const now = Date.now();
  
  const payload = {
    fromId: me.id,
    fromName: me.name || me.id, // Add name
    toId: activeChat.id,
    type: activeChat.type === 'group' ? 'group' : 'direct',
    text: text,
    image: imageData,
    ts: now
  };

  // Store locally
  const key = payload.type === 'group' ? chatKeyGroup(payload.toId) : chatKeyDirect(payload.fromId, payload.toId);
  messages[key] = messages[key] || [];
  messages[key].push(payload);
  
  // Mark as read for sender view
  lastRead[key] = now;
  saveLocal();
  renderMessages();
  messageInput.value = '';
  
  // Send to server
  socket.emit('send_message', payload);
}

mediaBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  mediaMenu.classList.toggle('hidden');
});

document.addEventListener('click', () => {
  mediaMenu.classList.add('hidden');
});

imageUpload.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleImageUpload(e.target.files[0]);
  }
});

cameraCapture.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleImageUpload(e.target.files[0]);
  }
});

function openCamera() {
  // Create camera UI
  const cameraUI = document.createElement('div');
  cameraUI.innerHTML = `
    <div style="position:fixed; top:0; left:0; right:0; bottom:0; background:black; z-index:1000; display:flex; flex-direction:column;">
      <video id="camera-preview" autoplay style="height:0; flex:1; object-fit:cover;"></video>
      <div style="padding:20px; display:flex; justify-content:space-around;">
        <button id="capture-btn" style="padding:10px 20px; border-radius:8px; background:var(--accent);">Capture</button>
        <button id="cancel-btn" style="padding:10px 20px; border-radius:8px;">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(cameraUI);

  const video = document.getElementById('camera-preview');
  
  // Get camera stream
  navigator.mediaDevices.getUserMedia({ 
    video: { facingMode: 'environment' }, 
    audio: false 
  })
  .then(stream => {
    video.srcObject = stream;
    
    // Handle capture
    document.getElementById('capture-btn').onclick = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const imageData = canvas.toDataURL('image/jpeg', 0.7);
      
      // Clean up
      stream.getTracks().forEach(track => track.stop());
      document.body.removeChild(cameraUI);
      
      // Send the image
      sendMessageWithImage(imageData);
    };
    
    // Handle cancel
    document.getElementById('cancel-btn').onclick = () => {
      stream.getTracks().forEach(track => track.stop());
      document.body.removeChild(cameraUI);
    };
  })
  .catch(err => {
    alert('Could not access camera: ' + err.message);
    document.body.removeChild(cameraUI);
  });
}

// ...existing code...

function showCanvas() {
  // avoid duplicate overlays
  if (document.getElementById('canvasOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'canvasOverlay';
  overlay.className = 'firstOverlay';
  overlay.style.zIndex = 1200;
  overlay.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>Draw</strong>
        <div style="display:flex;gap:8px;">
          <button id="canvasExitBtn" title="Exit" style="background:#e23f3f;color:white;border:2px solid rgba(255,255,255,0.06);border-radius:6px;padding:6px 8px;"><i class="fa-solid fa-xmark"></i></button>
          <button id="canvasClearBtn" title="Clear" style="background:#bb7b32;color:white;border:none;border-radius:6px;padding:6px 8px;"><i class="fa-solid fa-trash"></i></button>
          <button id="canvasSendBtn" title="Send" style="background:linear-gradient(90deg,#2b7cff,#9b3bff);color:white;border:none;border-radius:6px;padding:6px 8px;width:35px;">✔</button>
        </div>
      </div>

      <div style="display:flex;gap:12px;">
        <div style="flex:1; display:flex;flex-direction:column;gap:8px;">
          <canvas id="drawCanvas" style="background:#0b0b0b;border-radius:8px; width:100%; height:260px;"></canvas>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="width:60px;font-size:12px;">Hue</label>
            <input id="hueRange" type="range" min="0" max="360" value="210" />
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="width:60px;font-size:12px;">Sat</label>
            <input id="satRange" type="range" min="0" max="100" value="70" />
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="width:60px;font-size:12px;">Bri</label>
            <input id="valRange" type="range" min="0" max="100" value="55" />
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="width:60px;font-size:12px;">Size</label>
            <input id="thickRange" type="range" min="1" max="40" value="6" />
            <div id="colorPreview" style="width:26px;height:26px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const canvas = document.getElementById('drawCanvas');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(260 * dpr); // explicit height used in style above
  canvas.style.width = rect.width + 'px';
  canvas.style.height = 260 + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = 'transparent';
  ctx.clearRect(0,0,canvas.width,dpr ? canvas.height/dpr : canvas.height);

  let drawing = false;
  let last = { x: 0, y: 0 };

  const hueEl = document.getElementById('hueRange');
  const satEl = document.getElementById('satRange');
  const valEl = document.getElementById('valRange');
  const thickEl = document.getElementById('thickRange');
  const preview = document.getElementById('colorPreview');

  function hsvToRgb(h, s, v) {
    s /= 100; v /= 100;
    const c = v * s;
    const hh = h / 60;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (0 <= hh && hh < 1) [r,g,b] = [c,x,0];
    else if (1 <= hh && hh < 2) [r,g,b] = [x,c,0];
    else if (2 <= hh && hh < 3) [r,g,b] = [0,c,x];
    else if (3 <= hh && hh < 4) [r,g,b] = [0,x,c];
    else if (4 <= hh && hh < 5) [r,g,b] = [x,0,c];
    else [r,g,b] = [c,0,x];
    const m = v - c;
    r = Math.round((r + m) * 255);
    g = Math.round((g + m) * 255);
    b = Math.round((b + m) * 255);
    return `rgb(${r},${g},${b})`;
  }

  function updatePreview() {
    const col = hsvToRgb(+hueEl.value, +satEl.value, +valEl.value);
    preview.style.background = col;
  }
  updatePreview();

  function setStrokeStyle() {
    ctx.strokeStyle = hsvToRgb(+hueEl.value, +satEl.value, +valEl.value);
    ctx.lineWidth = +thickEl.value;
  }
  setStrokeStyle();

  hueEl.addEventListener('input', () => { updatePreview(); setStrokeStyle(); });
  satEl.addEventListener('input', () => { updatePreview(); setStrokeStyle(); });
  valEl.addEventListener('input', () => { updatePreview(); setStrokeStyle(); });
  thickEl.addEventListener('input', () => { setStrokeStyle(); });

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    if (e.touches && e.touches[0]) {
      return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
    }
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function start(e) {
    e.preventDefault();
    drawing = true;
    last = getPos(e);
  }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = getPos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }
  function stop(e) {
    if (!drawing) return;
    drawing = false;
  }

  // mouse
  canvas.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', stop);
  // touch
  canvas.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', stop);

  // clear button
  document.getElementById('canvasClearBtn').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
  // exit button
  document.getElementById('canvasExitBtn').addEventListener('click', () => {
    cleanup();
  });

  // send button: convert to dataURL and reuse existing sendMessageWithImage
  document.getElementById('canvasSendBtn').addEventListener('click', () => {
    // draw background transparent -> send as JPEG, convert using white bg to avoid black
    // create temp canvas to flatten at 1x CSS pixels
    const flat = document.createElement('canvas');
    const cssW = canvas.getBoundingClientRect().width;
    const cssH = 260;
    flat.width = Math.floor(cssW);
    flat.height = Math.floor(cssH);
    const fctx = flat.getContext('2d');
    // optional white background to avoid transparency artifacts in JPEG
    fctx.fillStyle = 'white';
    fctx.fillRect(0,0,flat.width,flat.height);
    // draw the drawing scaled down from HiDPI back to CSS pixels
    fctx.drawImage(canvas, 0, 0, flat.width, flat.height);
    const data = flat.toDataURL('image/jpeg', 0.9);
    // reuse existing sender (will alert if no active chat)
    sendMessageWithImage(data);
    cleanup();
  });

  // clicking outside card closes overlay
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) cleanup();
  });

  function cleanup() {
    // remove listeners
    try {
      canvas.removeEventListener('mousedown', start);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      canvas.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', stop);
    } catch (e) {}
    const el = document.getElementById('canvasOverlay');
    if (el) el.parentNode.removeChild(el);
  }
}
window.showCanvas = showCanvas;

// Update the camera capture click handler
document.querySelector('.media-option:nth-child(2)').onclick = (e) => {
  e.preventDefault();
  mediaMenu.classList.add('hidden');
  openCamera();
};

const callBtn = document.getElementById('callBtn');
const incomingCallOverlay = document.getElementById('incomingCallOverlay');
const incomingCallerName = document.getElementById('incomingCallerName');
const incomingCallerId = document.getElementById('incomingCallerId');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const declineCallBtn = document.getElementById('declineCallBtn');

const callOverlay = document.getElementById('callOverlay');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const endCallBtn = document.getElementById('endCallBtn');

let pc = null;
let localStream = null;
let remoteStream = null;
let isCaller = false;
let currentCallPeerId = null;
let pendingIce = []; // <-- added: queue ICE candidates that arrive before remote description

// update call button visibility whenever active chat or presence changes
function updateCallButtonVisibility() {
  // hide by default if no active chat or no call button element
  if (!activeChat || !document.getElementById('callBtn')) {
    const btn = document.getElementById('callBtn');
    if (btn) btn.classList.add('hidden');
    return;
  }

  // Only show call button for direct (one-on-one) chats when the peer is online.
  // Do NOT show for groups.
  if (activeChat.type === 'direct') {
    const peerId = activeChat.id;
    const enabled = !!me && !!peerId && !!window.onlineStatuses && !!window.onlineStatuses[peerId];
    document.getElementById('callBtn').classList.toggle('hidden', !enabled);
    return;
  }

  // For groups (or any other type) always hide the call button
  document.getElementById('callBtn').classList.add('hidden');
}

window.updateCallButtonVisibility = updateCallButtonVisibility;
window.onlineStatuses = onlineStatuses;

// call utility: create RTCPeerConnection and wire events
function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  if (!remoteStream) remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.ontrack = (ev) => {
    // prefer full MediaStream from event when available (safer across browsers)
    if (ev.streams && ev.streams[0]) {
      remoteVideo.srcObject = ev.streams[0];
    } else {
      // fallback — add individual tracks to our remoteStream
      if (!remoteStream) remoteStream = new MediaStream();
      ev.track && remoteStream.addTrack(ev.track);
      remoteVideo.srcObject = remoteStream;
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && currentCallPeerId) {
      socket.emit('call_ice', {
        toId: currentCallPeerId,
        fromId: me.id,
        candidate: ev.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      endLocalCall();
    }
  };

  return pc;
}

async function startLocalMedia(constraints = { audio: true, video: true }) {
  if (localStream) {
    // if already have, ensure video track enabled as requested
    return localStream;
  }
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  localVideo.srcObject = localStream;
  return localStream;
}

async function startCall() {
  if (!activeChat || activeChat.type === 'group') return alert('Select a person to call');
  const peerId = activeChat.id;
  if (!onlineStatuses[peerId]) return alert('User is not online');
  isCaller = true;
  currentCallPeerId = peerId;

  try {
    await startLocalMedia({ audio: true, video: true });
    createPeerConnection();
    // add local tracks
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    // show local overlay
    showCallOverlay();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // send offer to target via server
    socket.emit('call_offer', {
      toId: peerId,
      fromId: me.id,
      fromName: me.name,
      sdp: offer
    });
  } catch (err) {
    console.error('startCall error', err);
    alert('Could not start call: ' + (err.message || err));
    endLocalCall();
  }
}

async function acceptIncomingCall(offer, callerId) {
  isCaller = false;
  currentCallPeerId = callerId;
  try {
    await startLocalMedia({ audio: true, video: true });
    createPeerConnection();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    // set remote description then drain pending ICE
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    // drain queued ICE candidates that arrived early
    if (pendingIce.length) {
      for (const cand of pendingIce) {
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)); }
        catch (err) { console.warn('drain addIceCandidate failed', err); }
      }
      pendingIce = [];
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('call_answer', {
      toId: callerId,
      fromId: me.id,
      sdp: answer
    });

    showCallOverlay();
  } catch (err) {
    console.error('acceptIncomingCall error', err);
    socket.emit('call_decline', { toId: callerId, fromId: me.id });
    endLocalCall();
  }
}

function showIncomingOverlay(name, id) {
  incomingCallerName.textContent = name || id || 'Incoming call';
  incomingCallerId.textContent = id || '';
  incomingCallOverlay.classList.remove('hidden');
  incomingCallOverlay.setAttribute('aria-hidden', 'false');
}

function hideIncomingOverlay() {
  incomingCallOverlay.classList.add('hidden');
  incomingCallOverlay.setAttribute('aria-hidden', 'true');
}

function showCallOverlay() {
  callOverlay.classList.remove('hidden');
  callOverlay.setAttribute('aria-hidden', 'false');
  // button text initial state
  toggleVideoBtn.textContent = (localStream && localStream.getVideoTracks().length && localStream.getVideoTracks()[0].enabled) ? 'Video Off' : 'Video On';
}

function hideCallOverlay() {
  callOverlay.classList.add('hidden');
  callOverlay.setAttribute('aria-hidden', 'true');
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
}

// end/cleanup call locally and notify remote
function endLocalCall(notifyRemote = true) {
  try {
    if (notifyRemote && currentCallPeerId) {
      socket.emit('call_end', { toId: currentCallPeerId, fromId: me.id });
    }
  } catch (e) {}
  // stop local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(t => t.stop());
    remoteStream = null;
  }
  if (pc) {
    try { pc.close(); } catch(e){}
    pc = null;
  }
  // clear pending ICE so it doesn't affect future calls
  pendingIce = [];

  isCaller = false;
  currentCallPeerId = null;
  hideIncomingOverlay();
  hideCallOverlay();
}

// UI events
callBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  startCall();
});

// incoming overlay actions
acceptCallBtn.addEventListener('click', async () => {
  hideIncomingOverlay();
  // server stored the incomingOffer in the socket handler payload; we will rely on saved 'pendingIncomingOffer' set below
  if (pendingIncomingOffer && pendingIncomingOffer.offer && pendingIncomingOffer.fromId) {
    const offer = pendingIncomingOffer.offer;
    const fromId = pendingIncomingOffer.fromId;
    pendingIncomingOffer = null;
    await acceptIncomingCall(offer, fromId);
  }
});
declineCallBtn.addEventListener('click', () => {
  if (pendingIncomingOffer && pendingIncomingOffer.fromId) {
    socket.emit('call_decline', { toId: pendingIncomingOffer.fromId, fromId: me.id });
    pendingIncomingOffer = null;
  }
  hideIncomingOverlay();
});

toggleVideoBtn.addEventListener('click', () => {
  if (!localStream) return;
  const vtracks = localStream.getVideoTracks();
  if (!vtracks.length) return;
  const track = vtracks[0];
  track.enabled = !track.enabled;
  toggleVideoBtn.textContent = track.enabled ? 'Video Off' : 'Video On';
});

endCallBtn.addEventListener('click', () => {
  endLocalCall(true);
});

// signaling handlers (Socket.IO)
let pendingIncomingOffer = null;

socket.on('incoming_call', (data) => {
  // { fromId, fromName, sdp }
  // if we are already in a call, reject
  if (pc) {
    socket.emit('call_decline', { toId: data.fromId, fromId: me.id });
    return;
  }
  pendingIncomingOffer = { offer: data.sdp, fromId: data.fromId, fromName: data.fromName };
  showIncomingOverlay(data.fromName || data.fromId, data.fromId);
});

socket.on('call_answer', async (data) => {
  // { fromId, sdp }
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

    // drain any ICE candidates queued while remoteDescription was not set
    if (pendingIce.length) {
      for (const cand of pendingIce) {
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)); }
        catch (err) { console.warn('drain addIceCandidate failed', err); }
      }
      pendingIce = [];
    }
  } catch (err) {
    console.error('setRemoteDescription(answer) failed', err);
  }
});

socket.on('call_ice', async (data) => {
  // { fromId, candidate }
  if (!data || !data.candidate) return;

  // if pc is not created yet or remoteDescription is not set, queue the candidate
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
    pendingIce.push(data.candidate);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.warn('addIceCandidate failed', err);
  }
});

socket.on('call_end', (data) => {
  endLocalCall(false);
});

socket.on('call_decline', (data) => {
  // callee declined
  endLocalCall(false);
  alert('Call was declined');
});

// when other side answers the incoming call to them, we will be signaled via 'call_answer'
// finally, enable/disable call button whenever presence or activeChat changes
// hook into places where presence and activeChat change:
const orig_updateChatHeaderPresence = updateChatHeaderPresence;
updateChatHeaderPresence = function() {
  try { orig_updateChatHeaderPresence(); } catch(e){}
  updateCallButtonVisibility();
};

// initial call button update
updateCallButtonVisibility();

// existing saveLocal/renderContacts code paths should call updateCallButtonVisibility whenever relevant
})();

// delegated image zoom handling — single handler works for desktop & mobile and for images added later
messagesWindow.addEventListener('click', (ev) => {
  const img = ev.target.closest('.msgBubble img');
  if (!img) return;
  // prevent document-level click handlers from immediately closing the zoom
  ev.stopPropagation();

  // close any other zoomed image
  document.querySelectorAll('.msgBubble img.zoomed').forEach(el => {
    if (el !== img) el.classList.remove('zoomed');
  });

  img.classList.toggle('zoomed');
});

// close zoom when clicking anywhere outside an image
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.msgBubble img')) {
    document.querySelectorAll('.msgBubble img.zoomed').forEach(el => el.classList.remove('zoomed'));
  }
});
