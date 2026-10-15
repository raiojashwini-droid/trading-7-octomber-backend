// Calendar-day bounds that match DATE(column) filters in the IST session,
// without wrapping the column in DATE() (that blocks the exit-time index).

function isCalendarDay(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function startOfDay(dateStr) {
    return `${dateStr} 00:00:00`;
}

function nextDayStart(dateStr) {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const y = next.getUTCFullYear();
    const m = String(next.getUTCMonth() + 1).padStart(2, '0');
    const d = String(next.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d} 00:00:00`;
}

module.exports = { isCalendarDay, startOfDay, nextDayStart };
