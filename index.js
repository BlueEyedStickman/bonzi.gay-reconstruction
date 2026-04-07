var http = require("http");
var fs = require("fs");
var path = require("path");

// Read settings
var colors = fs.readFileSync("./config/colors.txt").toString().replace(/\r/g, "").split("\n").filter(Boolean);
var blacklist = fs.readFileSync("./config/blacklist.txt").toString().replace(/\r/g, "").split("\n");
var config = JSON.parse(fs.readFileSync("./config/config.json"));
if (blacklist.includes("")) blacklist = [];

// State
var rooms = {};
var userips = {};
var bans = {}; // ip -> { reason, end }
var guidcounter = 0;
var msgcounter = 0;
var messageLog = {}; // msgid -> { guid, room, text }

// Mime types for serving files
var mimeTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".webm": "video/webm",
    ".data": "application/octet-stream",
};

var server = http.createServer((req, res) => {
    // Set COOP/COEP on all responses (needed for SharedArrayBuffer/WASM workers)
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

    var url = req.url.split("?")[0];

    // Vault endpoint
    if (url === "/vault" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            try {
                let data = JSON.parse(body);
                let result = handleVault(data);
                res.end(JSON.stringify(result));
            } catch (e) {
                res.end(JSON.stringify({ message: "Invalid request.", tag: null }));
            }
        });
        return;
    }

    // Prevent directory traversal
    if (url.includes("..")) {
        res.writeHead(403);
        res.end();
        return;
    }

    var filePath = "./frontend" + url;
    if (url === "/" || url === "") filePath = "./frontend/index.html";

    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
        // Only serve index.html for navigation routes (no file extension), not for missing assets
        if (path.extname(url)) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        filePath = "./frontend/index.html";
    }

    var ext = path.extname(filePath).toLowerCase();
    var contentType = mimeTypes[ext] || "application/octet-stream";

    var data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.write(data);
    res.end();
});

// Vault puzzles
var vaultPuzzles = [
    { question: "A man walks into a bar to snort some cocaine.", lines: ["A man walks into a bar to snort some cocaine.", "The manager tells him to leave.", "I know you're clicking but like,", "what does the manager exactly say?"], answer: "no cocaine here bud", hat: "headphones" },
    { question: "What did your uncle leave you?", lines: ["Your uncle left you his meth lab in his will.", "The lawyer slides the deed across the table.", "Your mom is crying.", "Your dad is also crying but for different reasons.", "What did your uncle leave you?"], answer: "meth lab", hat: "unicorn" },
    { question: "What kind of offer is it?", lines: ["Don Corleone calls you into his office.", "He says he has an offer you can't refuse.", "You sit down.", "He looks at you for 45 seconds without blinking.", "What kind of offer is it?"], answer: "one you can't refuse", hat: "mustache" },
];

function handleVault(data) {
    var guess = (data.guess || "").trim().toLowerCase();
    var tag = data.tag || null;
    var puzzleIndex = 0;

    if (tag != null) {
        puzzleIndex = parseInt(tag);
        if (isNaN(puzzleIndex) || puzzleIndex < 0 || puzzleIndex >= vaultPuzzles.length) {
            puzzleIndex = 0;
        }
    }

    var puzzle = vaultPuzzles[puzzleIndex];

    if (!guess) {
        return { message: puzzle.question, lines: puzzle.lines, tag: String(puzzleIndex) };
    }

    if (guess === puzzle.answer) {
        var nextIndex = puzzleIndex + 1;
        if (nextIndex >= vaultPuzzles.length) {
            return { message: "You've solved all the puzzles!", lines: ["You've solved all the puzzles!"], tag: String(puzzleIndex), unlock: puzzle.hat };
        }
        var next = vaultPuzzles[nextIndex];
        return {
            message: next.question,
            lines: ["Correct!", ...next.lines],
            tag: String(nextIndex),
            unlock: puzzle.hat,
        };
    }

    return { message: "Wrong! Try again.", lines: ["Wrong! Try again.", ...puzzle.lines], tag: String(puzzleIndex) };
}

// Socket.io Server
var io = require("socket.io")(server, {
    allowEIO3: true,
});

server.listen(config.port, () => {
    rooms["default"] = new room("default");
    console.log("running at http://bonzi.localhost:" + config.port);
});

io.on("connection", (socket) => {
    var ip = socket.request.connection.remoteAddress;

    // Check ban
    if (bans[ip] && bans[ip].end > Date.now()) {
        socket.emit("ban", { reason: bans[ip].reason, end: bans[ip].end });
        socket.disconnect();
        return;
    } else if (bans[ip]) {
        delete bans[ip];
    }

    // Alt limit
    if (typeof userips[ip] === "undefined") userips[ip] = 0;
    userips[ip]++;

    if (userips[ip] > config.altlimit) {
        userips[ip]--;
        socket.disconnect();
        return;
    }

    new user(socket);
});

// Command list
var commands = {
    name: (victim, param) => {
        if (param === "" || param.length > config.namelimit) return;
        victim.public.name = param;
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    asshole: (victim, param) => {
        victim.room.emit("asshole", {
            guid: victim.public.guid,
            target: param,
        });
    },

    color: (victim, param) => {
        param = param.toLowerCase();
        if (!colors.includes(param)) param = colors[Math.floor(Math.random() * colors.length)];
        victim.public.color = param;
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    hat: (victim, param) => {
        var hatList = param.split(" ").filter(Boolean);
        if (hatList.length === 0) {
            // Remove hats
            var base = victim.public.color.split(" ")[0];
            victim.public.color = base;
        } else {
            var base = victim.public.color.split(" ")[0];
            var maxHats = victim.blessed ? 3 : 1;
            hatList = hatList.slice(0, maxHats);
            victim.public.color = base + " " + hatList.join(" ");
        }
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    pitch: (victim, param) => {
        param = parseInt(param);
        if (isNaN(param)) return;
        param = Math.max(0, Math.min(200, param));
        victim.public.pitch = param;
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    speed: (victim, param) => {
        param = parseInt(param);
        if (isNaN(param) || param > 400) return;
        victim.public.speed = param;
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    godmode: (victim, param) => {
        if (param === config.godword) {
            victim.level = 2;
            victim.socket.emit("admin");
        }
    },

    kingmode: (victim, param) => {
        console.log("[kingmode] param:", JSON.stringify(param), "kingword:", JSON.stringify(config.kingword), "loggedin:", victim.loggedin);
        if (config.kingword && param === config.kingword && victim.loggedin) {
            victim.level = Math.max(victim.level, 1);
            victim.public.king = true;
            victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
            victim.socket.emit("king");
            console.log("[kingmode] granted to", victim.public.name);
        }
    },

    pope: (victim, param) => {
        if (victim.level < 2) return;
        victim.public.color = "pope";
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    restart: (victim, param) => {
        if (victim.level < 2) return;
        process.exit();
    },

    update: (victim, param) => {
        if (victim.level < 2) return;
        colors = fs.readFileSync("./config/colors.txt").toString().replace(/\r/g, "").split("\n").filter(Boolean);
        blacklist = fs.readFileSync("./config/blacklist.txt").toString().replace(/\r/g, "").split("\n");
        config = JSON.parse(fs.readFileSync("./config/config.json"));
        if (blacklist.includes("")) blacklist = [];
    },

    joke: (victim, param) => {
        victim.room.emit("joke", { guid: victim.public.guid, rng: Math.random() });
    },

    fact: (victim, param) => {
        victim.room.emit("fact", { guid: victim.public.guid, rng: Math.random() });
    },

    backflip: (victim, param) => {
        victim.room.emit("backflip", { guid: victim.public.guid, swag: param.toLowerCase() === "swag" });
    },

    owo: (victim, param) => {
        victim.room.emit("owo", {
            guid: victim.public.guid,
            target: param,
        });
    },

    sanitize: (victim, param) => {
        if (victim.level < 2) return;
        victim.sanitize = !victim.sanitize;
    },

    triggered: (victim, param) => {
        victim.room.emit("triggered", { guid: victim.public.guid });
    },

    linux: (victim, param) => {
        victim.room.emit("linux", { guid: victim.public.guid });
    },

    pawn: (victim, param) => {
        victim.room.emit("pawn", { guid: victim.public.guid });
    },

    youtube: (victim, param) => {
        victim.room.emit("youtube", { guid: victim.public.guid, vid: param.replace(/"/g, "&quot;") });
    },

    // Moderation commands
    kick: (victim, param) => {
        if (victim.level < 1) return;
        var parts = param.split(" ");
        var targetGuid = parts[0];
        var reason = parts.slice(1).join(" ") || "No reason given.";
        var target = findUserByGuid(victim.room, targetGuid);
        if (target && target.level < victim.level) {
            target.socket.emit("kick", { reason: reason });
            target.socket.disconnect();
        }
    },

    tempban: (victim, param) => {
        if (victim.level < 1) return;
        var parts = param.split(" ");
        var duration = parts[0]; // "short" or "long"
        var targetGuid = parts[1];
        var reason = parts.slice(2).join(" ") || "No reason given.";
        var target = findUserByGuid(victim.room, targetGuid);
        if (target && target.level < victim.level) {
            var ms = duration === "long" ? 3600000 : 300000; // 1h or 5m
            var ip = target.socket.request.connection.remoteAddress;
            bans[ip] = { reason: reason, end: Date.now() + ms };
            target.socket.emit("ban", { reason: reason, end: Date.now() + ms });
            target.socket.disconnect();
        }
    },

    ban: (victim, param) => {
        if (victim.level < 2) return;
        var targetGuid = param.trim();
        var target = findUserByGuid(victim.room, targetGuid);
        if (target) {
            var ip = target.socket.request.connection.remoteAddress;
            var reason = "Banned by admin.";
            bans[ip] = { reason: reason, end: Date.now() + 86400000 * 30 }; // 30 days
            target.socket.emit("ban", { reason: reason, end: bans[ip].end });
            target.socket.disconnect();
        }
    },

    shush: (victim, param) => {
        if (victim.level < 1) return;
        var targetGuid = param.trim();
        var target = findUserByGuid(victim.room, targetGuid);
        if (target) {
            target.shushed = !target.shushed;
        }
    },

    info: (victim, param) => {
        if (victim.level < 2) return;
        var targetGuid = param.trim();
        var target = findUserByGuid(victim.room, targetGuid);
        if (target) {
            var ip = target.socket.request.connection.remoteAddress;
            victim.socket.emit("alert", {
                text: "Name: " + target.public.name + "\nGUID: " + target.public.guid + "\nIP: " + ip + "\nLevel: " + target.level,
            });
        }
    },

    bless: (victim, param) => {
        if (victim.level < 1) return;
        var targetGuid = param.trim();
        var target = findUserByGuid(victim.room, targetGuid);
        if (target) {
            target.blessed = true;
            victim.room.emit("update", { guid: target.public.guid, userPublic: target.public });
            target.socket.emit("blessed");
        }
    },

    nameedit: (victim, param) => {
        if (victim.level < 1) return;
        var parts = param.split(" ");
        var targetGuid = parts[0];
        var newName = parts.slice(1).join(" ");
        if (!newName || newName.length > config.namelimit) return;
        var target = findUserByGuid(victim.room, targetGuid);
        if (target) {
            target.public.name = newName;
            victim.room.emit("update", { guid: target.public.guid, userPublic: target.public });
        }
    },

    tagedit: (victim, param) => {
        if (victim.level < 1) return;
        var parts = param.split(" ");
        var targetGuid = parts[0];
        var newTag = parts.slice(1).join(" ");
        var target = findUserByGuid(victim.room, targetGuid);
        if (target) {
            target.public.tag = newTag || "";
            victim.room.emit("update", { guid: target.public.guid, userPublic: target.public });
        }
    },

    nuke: (victim, param) => {
        if (victim.level < 1) return;
        var targetGuid = param.trim();
        victim.room.emit("nuke", { guid: targetGuid });
    },

    img: (victim, param) => {
        var url = param.trim();
        if (!url) return;
        // Basic URL validation
        if (!url.match(/^https?:\/\//)) return;
        msgcounter++;
        var msgid = msgcounter;
        messageLog[msgid] = { guid: victim.public.guid, room: victim.room.name, text: "(image)" };
        victim.room.emit("image", { guid: victim.public.guid, url: url, msgid: msgid });
    },

    video: (victim, param) => {
        var url = param.trim();
        if (!url) return;
        if (!url.match(/^https?:\/\//)) return;
        msgcounter++;
        var msgid = msgcounter;
        messageLog[msgid] = { guid: victim.public.guid, room: victim.room.name, text: "(video)" };
        victim.room.emit("video", { guid: victim.public.guid, url: url, msgid: msgid });
    },

    advpoll: (victim, param) => {
        // Format: title;option1;option2;...
        // Escaped semicolons: \;
        var parts = [];
        var current = "";
        for (var i = 0; i < param.length; i++) {
            if (param[i] === "\\" && i + 1 < param.length) {
                current += param[i + 1];
                i++;
            } else if (param[i] === ";") {
                parts.push(current);
                current = "";
            } else {
                current += param[i];
            }
        }
        parts.push(current);

        var title = parts[0];
        var options = parts.slice(1).filter(Boolean);
        if (!title || options.length < 2 || options.length > 5) return;
        if (filtertext(title) || options.some(o => filtertext(o))) return;

        var pollId = "poll_" + (++msgcounter);
        polls[pollId] = { title: title, options: options, votes: {} };
        victim.room.emit("poll", {
            guid: victim.public.guid,
            poll: pollId,
            title: title,
            options: options,
        });
    },

    delete: (victim, param) => {
        if (victim.level < 1) return;
        var msgid = param.trim();
        if (messageLog[msgid]) {
            victim.room.emit("delete", { ids: [msgid] });
            delete messageLog[msgid];
        }
    },

    banmsg: (victim, param) => {
        if (victim.level < 1) return;
        var msgid = param.trim();
        var msg = messageLog[msgid];
        if (!msg) return;
        var target = findUserByGuid(victim.room, msg.guid);
        victim.room.emit("delete", { ids: [msgid] });
        delete messageLog[msgid];
        if (target && target.level < victim.level) {
            var ip = target.socket.request.connection.remoteAddress;
            bans[ip] = { reason: "Banned for message content.", end: Date.now() + 300000 };
            target.socket.emit("ban", { reason: "Banned for message content.", end: bans[ip].end });
            target.socket.disconnect();
        }
    },

    french: (victim, param) => {
        if (!param) return;
        victim.room.emit("french", { guid: victim.public.guid, text: param });
    },

    xss: (victim, param) => {
        if (victim.level < 2) return;
        if (!param) return;
        victim.room.emit("xss", { guid: victim.public.guid, text: param });
    },

    angel: (victim) => {
        if (!victim.blessed) return;
        victim.public.color = "angel";
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    glow: (victim) => {
        if (!victim.blessed) return;
        victim.public.color = "glow";
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    noob: (victim) => {
        if (!victim.blessed) return;
        victim.public.color = "noob";
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },

    gold: (victim) => {
        if (!victim.blessed) return;
        victim.public.color = "gold";
        victim.room.emit("update", { guid: victim.public.guid, userPublic: victim.public });
    },
};

var polls = {};

function findUserByGuid(room, guid) {
    guid = parseInt(guid);
    for (var i = 0; i < room.users.length; i++) {
        if (room.users[i].public.guid === guid) return room.users[i];
    }
    return null;
}

// User object
class user {
    constructor(socket) {
        this.socket = socket;
        this.loggedin = false;
        this.level = 0;
        this.public = {};
        this.slowed = false;
        this.sanitize = true;
        this.shushed = false;
        this.blessed = false;

        this.socket.on("login", (logdata) => {
            if (typeof logdata !== "object" || typeof logdata.name !== "string" || typeof logdata.room !== "string") return;
            if (logdata.name == undefined || logdata.room == undefined) logdata = { room: "default", name: "Anonymous" };
            (logdata.name === "" || logdata.name.length > config.namelimit || filtertext(logdata.name)) && (logdata.name = "Anonymous");
            logdata.name.replace(/ /g, "") === "" && (logdata.name = "Anonymous");

            if (this.loggedin === false) {
                this.loggedin = true;
                this.public.name = logdata.name;
                this.public.color = colors[Math.floor(Math.random() * colors.length)];
                this.public.pitch = 100;
                this.public.speed = 100;
                this.public.tag = "";
                this.public.typing = "";
                this.public.king = false;
                guidcounter++;
                this.public.guid = guidcounter;
                var roomname = logdata.room;
                if (roomname === "") roomname = "default";
                if (rooms[roomname] == undefined) rooms[roomname] = new room(roomname);
                this.room = rooms[roomname];
                this.room.users.push(this);
                this.room.usersPublic[this.public.guid] = this.public;

                this.socket.emit("updateAll", { usersPublic: this.room.usersPublic });
                this.room.emit("update", { guid: this.public.guid, userPublic: this.public }, this);
            }

            // Send room info with user's guid and unlocks
            this.socket.emit("room", {
                room: this.room.name,
                isOwner: this.room.users[0] === this,
                isPublic: this.room.name === "default",
                you: this.public.guid,
                unlocks: this.unlockList || [],
            });

            // Send privilege notifications
            if (this.level >= 2) this.socket.emit("admin");
            if (this.level >= 1) this.socket.emit("king");
            if (this.blessed) this.socket.emit("blessed");
        });

        // Talk
        this.socket.on("talk", (msg) => {
            if (typeof msg !== "object" || typeof msg.text !== "string") return;
            if (this.shushed) return;

            var text = msg.text;
            if (text.length > config.charlimit) text = text.substring(0, config.charlimit);
            if (this.sanitize) text = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            if (filtertext(text) && this.sanitize) text = "RAPED AND ABUSED";

            if (!this.slowed) {
                msgcounter++;
                var msgid = msgcounter;
                var talkData = { guid: this.public.guid, text: text, msgid: msgid };

                // Handle quotes/replies
                if (msg.quote && typeof msg.quote === "object") {
                    talkData.quote = {
                        name: String(msg.quote.name || "").substring(0, config.namelimit),
                        text: String(msg.quote.text || "").substring(0, config.charlimit),
                    };
                }

                messageLog[msgid] = { guid: this.public.guid, room: this.room.name, text: text };
                this.room.emit("talk", talkData);

                this.slowed = true;
                setTimeout(() => {
                    this.slowed = false;
                }, config.slowmode);
            }
        });

        // Typing indicator
        this.socket.on("typing", (state) => {
            if (state === 1) {
                this.public.typing = "typing...";
            } else {
                this.public.typing = "";
            }
            this.room.emit("update", { guid: this.public.guid, userPublic: this.public });
        });

        // Vote on polls
        this.socket.on("vote", (data) => {
            if (typeof data !== "object" || typeof data.poll !== "string" || typeof data.vote !== "number") return;
            var poll = polls[data.poll];
            if (!poll) return;
            if (data.vote < 0 || data.vote >= poll.options.length) return;
            poll.votes[this.public.guid] = data.vote;
            this.room.emit("vote", { poll: data.poll, guid: this.public.guid, vote: data.vote });
        });

        // Disconnect
        this.socket.on("disconnect", () => {
            var ip = this.socket.request.connection.remoteAddress;
            userips[ip]--;
            if (userips[ip] === 0) delete userips[ip];

            if (this.loggedin) {
                delete this.room.usersPublic[this.public.guid];
                this.room.emit("leave", { guid: this.public.guid });
                this.room.users.splice(this.room.users.indexOf(this), 1);

                // Clean up empty rooms (except default)
                if (this.room.users.length === 0 && this.room.name !== "default") {
                    delete rooms[this.room.name];
                }
            }
        });

        // Command handler
        this.socket.on("command", (cmd) => {
            if (typeof cmd !== "object" || !Array.isArray(cmd.list) || cmd.list[0] == undefined) return;
            var comd = cmd.list[0];
            var param = "";
            if (cmd.list[1] == undefined) {
                param = "";
            } else {
                var paramList = cmd.list.slice(1);
                param = paramList.join(" ");
            }
            if (typeof param !== "string") return;
            if (this.sanitize) param = param.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            if (filtertext(param) && this.sanitize) return;

            if (!this.slowed) {
                if (commands[comd] !== undefined) commands[comd](this, param);
                this.slowed = true;
                setTimeout(() => {
                    this.slowed = false;
                }, config.slowmode);
            }
        });
    }
}

// Room
class room {
    constructor(name) {
        this.name = name;
        this.users = [];
        this.usersPublic = {};
    }

    emit(event, msg, sender) {
        this.users.forEach((user) => {
            if (user !== sender) user.socket.emit(event, msg);
        });
    }
}

// Blacklist filter
function filtertext(tofilter) {
    var filtered = false;
    blacklist.forEach((listitem) => {
        if (listitem && tofilter.includes(listitem)) filtered = true;
    });
    return filtered;
}
