window.debugOffset = 0;
window.setDebugTime = (val) => {
    if (val === 'reset') {
        window.debugOffset = 0;
        console.log('Debug time reset to real time.');
        return;
    }
    const target = new Date(val).getTime();
    if (!isNaN(target)) {
        window.debugOffset = target - Date.now();
        console.log(`Debug time set to: ${new Date(target).toLocaleString()}`);
    } else {
        console.log('Usage: setDebugTime("2024-12-24T12:00:00") or setDebugTime("reset")');
    }
};
window.getNow = () => Date.now() + (window.debugOffset || 0);

window.qs = (name, fallback = '') => {
    const baked = window.WIDGET_CONFIG && window.WIDGET_CONFIG[name];
    if (baked !== undefined && baked !== null && baked !== '') return String(baked);
    const value = new URLSearchParams(window.location.search).get(name);
    return (value === null || value === '') ? fallback : value;
};

window.requireParam = (name) => {
    const value = window.qs(name);
    if (!value) {
        document.body.innerHTML = `<div class="missing-param">Missing required parameter: <strong>${name}</strong></div>`;
        throw new Error('Missing required parameter: ' + name);
    }
    return value;
};
