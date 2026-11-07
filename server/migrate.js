import {connectDatabase,migrate} from './db.js';
const db=await connectDatabase();await migrate(db);await db.close();console.log('Schema migration complete');
