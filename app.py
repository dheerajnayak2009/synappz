import os
import json
import time
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config['SECRET_KEY'] = 'synappz-secret-key'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

MESSAGES_FILE = "messages.json"
USERS_FILE = "users.json"

def load_messages():
    if not os.path.exists(MESSAGES_FILE):
        data = {"chats": {}, "groups": {}}
        with open(MESSAGES_FILE, "w") as f:
            json.dump(data, f)
        return data
    with open(MESSAGES_FILE, "r") as f:
        try:
            return json.load(f)
        except:
            return {"chats": {}, "groups": {}}

def save_messages(data):
    with open(MESSAGES_FILE, "w") as f:
        json.dump(data, f, indent=2)

def load_users():
    if not os.path.exists(USERS_FILE):
        data = {"users": {}}
        with open(USERS_FILE, "w") as f:
            json.dump(data, f)
        return data
    with open(USERS_FILE, "r") as f:
        try:
            return json.load(f)
        except:
            return {"users": {}}

def save_users(data):
    with open(USERS_FILE, "w") as f:
        json.dump(data, f, indent=2)

messages_store = load_messages()
users_store = load_users()
connected_users = {}  # user_id -> set(socket_sid)


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def on_connect():
    print("Socket connected:", request.sid)


@socketio.on("introduce")
def on_introduce(payload):
    """payload: { userId, name }"""
    user_id = payload.get("userId")
    if not user_id:
        emit("introduce_result", {"ok": False, "reason": "invalid_id"}, room=request.sid)
        return

    # Check if this is a first-time setup (has password) vs reconnect
    is_new_user = bool(payload.get("password"))
    
    # For new users, check if ID already exists
    if is_new_user and user_id in users_store["users"]:
        emit("introduce_result", {"ok": False, "reason": "exists"}, room=request.sid)
        return

    # Add this socket sid to the user's set of connected sids
    sids = connected_users.setdefault(user_id, set())
    sids.add(request.sid)

    # Important: First broadcast that this user is online
    emit("presence_update", {"id": user_id, "online": True}, broadcast=True)

    # Then send current online users list to ALL clients
    online_ids = list(connected_users.keys())
    emit("presence_init", online_ids, broadcast=True)
    
    # Update user record
    users_store["users"].setdefault(user_id, {})
    users_store["users"][user_id].update({
        "id": user_id,
        "name": payload.get("name"),
        "lastSeen": int(time.time() * 1000)
    })
    save_users(users_store)

    # Handle any pending contacts
    pending = users_store["users"][user_id].get("pending_contacts", [])
    if pending:
        users_store["users"][user_id]["pending_contacts"] = []
        save_users(users_store)
        for contact in pending:
            emit("contact_added", contact, room=request.sid)

    emit("introduce_result", {"ok": True}, room=request.sid)
    

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    for uid, sids in list(connected_users.items()):
        if sid in sids:
            sids.remove(sid)
            # if no more sockets for this uid, user is fully offline — broadcast offline presence
            if not sids:
                del connected_users[uid]
                # update lastSeen in users_store
                if uid in users_store["users"]:
                    users_store["users"][uid]["lastSeen"] = int(time.time() * 1000)
                    save_users(users_store)
                emit("presence_update", {"id": uid, "online": False, "lastSeen": int(time.time() * 1000)}, broadcast=True)
            break
    print("Socket disconnected:", sid)


# ✅ --- MESSAGE SEND ---
@socketio.on("send_message")
def on_send_message(payload):
    from_id = payload.get("fromId")
    to_id = payload.get("toId")
    msg_type = payload.get("type", "direct")

    msg = {
        "fromId": from_id,
        "fromName": payload.get("fromName"),
        "toId": to_id,
        "type": msg_type,
        "text": payload.get("text"),
        "image": payload.get("image"),  # Add this line
        "ts": payload.get("ts")
    }

    store = load_messages()

    if msg_type == "group":
        key = f"group:{to_id}"
        store["chats"].setdefault(key, []).append(msg)
        save_messages(store)
        emit("message", msg, broadcast=True)
    else:
        a, b = sorted([from_id, to_id])
        key = f"chat:{a}__{b}"
        store["chats"].setdefault(key, []).append(msg)
        save_messages(store)
        recipients = connected_users.get(to_id, set())
        for sid in list(recipients):
            emit("message", msg, room=sid)
        emit("message", msg, room=request.sid)


# ✅ --- MESSAGE EDIT ---
@socketio.on("edit_message")
def on_edit_message(data):
    """payload: { key, ts, newText }"""
    key = data.get("key")
    ts = data.get("ts")
    new_text = data.get("newText")

    store = load_messages()
    chat_list = store["chats"].get(key, [])
    for msg in chat_list:
        if msg.get("ts") == ts:
            msg["text"] = new_text + " (edited)"
            break
    save_messages(store)

    emit("message_edited", {"key": key, "ts": ts, "newText": new_text}, broadcast=True)


# ✅ --- MESSAGE DELETE ---
@socketio.on("delete_message")
def on_delete_message(data):
    """payload: { key, ts }"""
    key = data.get("key")
    ts = data.get("ts")

    store = load_messages()
    chat_list = store["chats"].get(key, [])
    for msg in chat_list:
        if msg.get("ts") == ts:
            msg["text"] = "message deleted"
            msg["deleted"] = True
            break
    save_messages(store)

    emit("message_deleted", {"key": key, "ts": ts}, broadcast=True)


# ✅ --- GROUP CREATE ---
@socketio.on("create_group")
def on_create_group(payload):
    """payload: { groupId, name, members, creatorId }"""
    store = load_messages()
    gid = payload.get("groupId")
    store.setdefault("groups", {})
    store["groups"][gid] = {
        "groupId": gid,
        "name": payload.get("name"),
        "members": payload.get("members", []),
        "creator": payload.get("creatorId")
    }
    save_messages(store)
    emit("group_created", store["groups"][gid], broadcast=True)


# ✅ --- GROUP LEAVE ---
@socketio.on("group_leave")
def on_group_leave(payload):
    """payload: { groupId, userId }"""
    gid = payload.get("groupId")
    uid = payload.get("userId")

    store = load_messages()
    group = store["groups"].get(gid)
    if group and uid in group.get("members", []):
        group["members"].remove(uid)
        save_messages(store)

    leave_msg = {
        "fromId": "system",
        "fromName": "",
        "toId": gid,
        "type": "group",
        "text": f"<i>{uid} left the group</i>",
        "ts": int(os.times()[4] * 1000)
    }
    key = f"group:{gid}"
    store["chats"].setdefault(key, []).append(leave_msg)
    save_messages(store)
    emit("message", leave_msg, broadcast=True)


# ✅ --- USER EXISTENCE CHECK ---
@socketio.on("check_user_exists")
def on_check_user_exists(payload):
    """Payload: { targetId, sourceId, sourceName }"""
    target_id = payload.get("targetId")
    source_id = payload.get("sourceId")
    source_name = payload.get("sourceName")

    # Check if user exists in persisted users
    exists = target_id in users_store["users"]

    if exists:
        # prepare reciprocal contact object
        reciprocal = {"id": source_id, "name": source_name}

        # If target user already online, push immediately to all their sids
        target_sids = connected_users.get(target_id, set())
        if target_sids:
            for sid in target_sids:
                emit("contact_added", reciprocal, room=sid)
        else:
            # if offline, persist in their pending_contacts so it's delivered when they next introduce
            users_store["users"].setdefault(target_id, {})
            pend = users_store["users"][target_id].setdefault("pending_contacts", [])
            # avoid duplicates
            if not any(p.get("id") == source_id for p in pend):
                pend.append(reciprocal)
                save_users(users_store)

    # always reply to requester whether the target account exists
    emit("user_exists_result", exists)

# Add call signaling handlers near other @socketio.on handlers
@socketio.on('call_offer')
def handle_call_offer(payload):
    """payload: { toId, fromId, fromName, sdp }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    # forward to all connected sids of the callee
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        emit('incoming_call', {
            'fromId': payload.get('fromId'),
            'fromName': payload.get('fromName'),
            'sdp': payload.get('sdp')
        }, room=sid)

@socketio.on('call_answer')
def handle_call_answer(payload):
    """payload: { toId, fromId, sdp }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        emit('call_answer', {
            'fromId': payload.get('fromId'),
            'sdp': payload.get('sdp')
        }, room=sid)

@socketio.on('call_ice')
def handle_call_ice(payload):
    """payload: { toId, fromId, candidate }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        emit('call_ice', {
            'fromId': payload.get('fromId'),
            'candidate': payload.get('candidate')
        }, room=sid)

@socketio.on('call_end')
def handle_call_end(payload):
    """payload: { toId, fromId }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        emit('call_end', {
            'fromId': payload.get('fromId')
        }, room=sid)

@socketio.on('call_decline')
def handle_call_decline(payload):
    """payload: { toId, fromId }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        emit('call_decline', {
            'fromId': payload.get('fromId')
        }, room=sid)

# --- GROUP CALL SIGNALING (simple host->participants star topology) ---
@socketio.on('group_call_offer')
def handle_group_call_offer(payload):
    """payload: { groupId, toId, fromId, fromName, sdp }"""
    gid = payload.get('groupId')
    to_id = payload.get('toId')
    # if specific toId present, forward to that user's sids
    if to_id:
        sids = connected_users.get(to_id, set())
        for sid in list(sids):
            socketio.emit('group_call_offer', payload, room=sid)
        return
    # otherwise (fallback) forward to all group members (if group exists)
    store = load_messages()
    group = store.get('groups', {}).get(gid)
    if not group:
        return
    members = group.get('members', [])
    for m in members:
        if m == payload.get('fromId'): continue
        sids = connected_users.get(m, set())
        for sid in list(sids):
            socketio.emit('group_call_offer', payload, room=sid)

@socketio.on('group_call_decline')
def handle_group_call_decline(payload):
    """payload: { groupId, fromId, toId }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        socketio.emit('group_call_decline', payload, room=sid)

@socketio.on('group_call_answer')
def handle_group_call_answer(payload):
    """payload: { toId (host), fromId, sdp, groupId }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        socketio.emit('group_call_answer', payload, room=sid)

@socketio.on('group_call_ice')
def handle_group_call_ice(payload):
    """payload: { toId, fromId, candidate, groupId }"""
    to_id = payload.get('toId')
    if not to_id:
        return
    sids = connected_users.get(to_id, set())
    for sid in list(sids):
        socketio.emit('group_call_ice', payload, room=sid)

@socketio.on('group_call_end')
def handle_group_call_end(payload):
    """payload: { groupId, fromId }"""
    gid = payload.get('groupId')
    # broadcast to all connected members of group
    store = load_messages()
    group = store.get('groups', {}).get(gid)
    if not group:
        return
    members = group.get('members', [])
    for m in members:
        sids = connected_users.get(m, set())
        for sid in list(sids):
            socketio.emit('group_call_end', payload, room=sid)


if __name__ == "__main__":
    print("🚀 Starting Synappz server on http://localhost:5000")
    socketio.run(app, host="0.0.0.0", port=5000)
