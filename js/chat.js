window.CHAT_WS = 'wss://ytstats.arielcapdevila.com/api/ws/chat';

window.connectYouTubeChat = (videoId, handlers = {}) => {
    const url = `${window.CHAT_WS}?q=${encodeURIComponent(videoId)}`;
    let socket = null;
    let closed = false;
    let retry = 0;

    function open() {
        if (closed) return;
        socket = new WebSocket(url);
        socket.addEventListener('open', () => {
            retry = 0;
            handlers.onOpen?.(url);
        });
        socket.addEventListener('message', (event) => {
            let data = event.data;
            try { data = JSON.parse(event.data); } catch (_) {
                handlers.onRaw?.(event.data);
                return;
            }
            if (data.type === 'status') handlers.onStatus?.(data);
            else if (data.type === 'textMessage') handlers.onMessage?.(data);
            else handlers.onEvent?.(data);
        });
        socket.addEventListener('close', () => {
            handlers.onClose?.();
            if (closed) return;
            const wait = Math.min(8000, 1000 * (2 ** retry++));
            setTimeout(open, wait);
        });
        socket.addEventListener('error', () => handlers.onError?.());
    }

    open();
    return () => {
        closed = true;
        try { socket?.close(); } catch (_) {}
    };
};

window.isPaidChat = (msg) => msg && msg.amount != null && msg.amount !== '';

window.chatNorm = (text) => String(text || '').trim().toLowerCase();

window.authorNameClass = (author = {}) => {
    if (author.owner) return 'name-owner';
    if (author.moderator) return 'name-mod';
    if (author.member) return 'name-member';
    return '';
};

window.appendBadges = (parent, author = {}, paid = false) => {
    const add = (text, cls) => {
        const el = document.createElement('span');
        el.className = 'badge ' + cls;
        el.textContent = text;
        parent.appendChild(el);
    };
    if (author.owner) add('OWNER', 'owner');
    if (author.moderator) add('MOD', 'mod');
    if (author.member) add('MEMBER', 'member');
    if (author.verified) add('✓', 'verified');
    if (paid) add('PAID', 'paid');
};

window.avatarEl = (src, className = 'chat-avatar') => {
    const img = document.createElement('img');
    img.className = className;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = src || '';
    return img;
};

window.CHAT_MEDIA_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(gif|png|jpe?g|webp|avif)$/i;

window.chatMediaUrl = (text) => {
    const raw = String(text || '').trim();
    if (!CHAT_MEDIA_RE.test(raw)) return '';
    return 'https://greenbase.arielcapdevila.com/file/' + raw;
};

window.setChatContent = (el, text, imgClass = 'chat-media') => {
    el.replaceChildren();
    const url = chatMediaUrl(text);
    if (!url) {
        el.textContent = text || '';
        return;
    }
    const img = document.createElement('img');
    img.className = imgClass;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    el.appendChild(img);
};


