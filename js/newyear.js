const NY_TIMEZONES = [
    { offset: 14, label: 'Kiribati, Line Islands' },
    { offset: 13.75, label: 'Chatham Islands' },
    { offset: 13, label: 'New Zealand, Tonga, Samoa' },
    { offset: 12, label: 'Fiji, Kamchatka, Marshall Is.' },
    { offset: 11, label: 'Sydney, Melbourne, Solomon Is.' },
    { offset: 10.5, label: 'Adelaide, Lord Howe Is.' },
    { offset: 10, label: 'Brisbane, Guam, Vladivostok' },
    { offset: 9.5, label: 'Darwin' },
    { offset: 9, label: 'Tokyo, Seoul' },
    { offset: 8.75, label: 'Eucla (Western Australia)' },
    { offset: 8, label: 'Beijing, Perth, Singapore' },
    { offset: 7, label: 'Bangkok, Jakarta, Vietnam' },
    { offset: 6.5, label: 'Yangon, Cocos Islands' },
    { offset: 6, label: 'Dhaka' },
    { offset: 5.75, label: 'Kathmandu' },
    { offset: 5.5, label: 'New Delhi, Sri Lanka' },
    { offset: 5, label: 'Islamabad, Karachi' },
    { offset: 4.5, label: 'Kabul' },
    { offset: 4, label: 'Dubai, Baku' },
    { offset: 3.5, label: 'Tehran' },
    { offset: 3, label: 'Moscow, Riyadh, Baghdad, Nairobi' },
    { offset: 2, label: 'Athens, Cairo, Johannesburg' },
    { offset: 1, label: 'Paris, Berlin, Rome, Lagos' },
    { offset: 0, label: 'London, Lisbon, UTC' },
    { offset: -1, label: 'Azores, Cape Verde' },
    { offset: -2, label: 'South Georgia' },
    { offset: -3, label: 'Rio de Janeiro, Buenos Aires' },
    { offset: -3.5, label: 'Newfoundland' },
    { offset: -4, label: 'Halifax, Caracas, La Paz' },
    { offset: -5, label: 'New York, Toronto, Bogota' },
    { offset: -6, label: 'Chicago, Mexico City' },
    { offset: -7, label: 'Denver, Calgary' },
    { offset: -8, label: 'Los Angeles, Vancouver' },
    { offset: -9, label: 'Anchorage, Gambier Is.' },
    { offset: -9.5, label: 'Marquesas Islands' },
    { offset: -10, label: 'Hawaii, Tahiti' },
    { offset: -11, label: 'American Samoa' },
    { offset: -12, label: 'Baker Island' }
];

function nyFormatTime(ms) {
    if (!ms || ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
}

function nyUpcoming(keepMs = 5000) {
    const currentUTCTime = getNow();
    const now = new Date(currentUTCTime);
    let targetYear = now.getUTCFullYear();
    // Baker Island (UTC-12) is last: midnight there is 12:00 UTC on Jan 1
    const lastNewYearUtc = Date.UTC(targetYear, 0, 1, 12, 0, 0);
    if (currentUTCTime >= lastNewYearUtc) targetYear++;
    const upcoming = [];
    NY_TIMEZONES.forEach((tz) => {
        const newYearTimeUTC = Date.UTC(targetYear, 0, 1, 0, 0, 0) - (tz.offset * 3600 * 1000);
        const diff = newYearTimeUTC - currentUTCTime;
        if (diff > -keepMs) upcoming.push({ ...tz, time: newYearTimeUTC, diff });
    });
    upcoming.sort((a, b) => a.diff - b.diff);
    return upcoming;
}

function updateReel(container, targetText) {
    const createDigitWindow = (char) => {
        const win = document.createElement('div');
        win.className = 'ny-digit-window';
        win.innerHTML = `
            <div class="ny-digit-track" style="transform: translateY(0);">
                <span class="ny-digit-val">${char}</span>
                <span class="ny-digit-val">${char}</span>
            </div>
        `;
        return win;
    };
    const isReel = container.firstChild && container.firstChild.classList && container.firstChild.classList.contains('ny-digit-window');
    if (!isReel || container.children.length !== targetText.length) {
        container.innerHTML = '';
        targetText.split('').forEach((char) => container.appendChild(createDigitWindow(char)));
        return;
    }
    targetText.split('').forEach((char, charIdx) => {
        const win = container.children[charIdx];
        if (!win) return;
        const track = win.querySelector('.ny-digit-track');
        const slots = track.querySelectorAll('.ny-digit-val');
        if (!track || slots.length < 2) return;
        if (slots[0].innerText !== char) {
            slots[1].innerText = char;
            track.style.transform = 'translateY(-1em)';
            if (!win.dataset.animating) {
                win.dataset.animating = 'true';
                setTimeout(() => {
                    if (track && slots[0]) {
                        slots[0].innerText = char;
                        track.style.transition = 'none';
                        track.style.transform = 'translateY(0)';
                        void track.offsetWidth;
                        track.style.transition = 'transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1)';
                    }
                    delete win.dataset.animating;
                }, 300);
            }
        }
    });
}
