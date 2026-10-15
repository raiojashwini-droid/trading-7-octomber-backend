const db = require('../src/config/db');

async function killLocks() {
    try {
        const [processes] = await db.execute("SHOW PROCESSLIST");
        console.log('Active DB Processes:', processes.length);
        for (const proc of processes) {
            if (proc.command === 'Query' || proc.command === 'Sleep') {
                if (proc.id !== processes[0].id) {
                    try {
                        await db.execute(`KILL ${proc.id}`);
                        console.log(`Killed process ${proc.id}`);
                    } catch (_) {}
                }
            }
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

killLocks();
