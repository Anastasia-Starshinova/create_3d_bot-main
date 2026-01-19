import { Telegraf, Context } from 'telegraf';
import { Pool } from 'pg';
import { createSessionMiddleware, cancelProcess, requireSession } from '../utils/session';

const ADMIN_STATES = {
  IDLE: 'idle',
  WAITING_FOR_TABLE: 'waiting_for_table',
  WAITING_FOR_OLD_COLUMN: 'waiting_for_old_column',
  WAITING_FOR_NEW_COLUMN: 'waiting_for_new_column',
  WAITING_FOR_TABLE_FOR_NEW_COLUMN: 'waiting_for_table_for_new_column',
  WAITING_FOR_NEW_COLUMN_NAME: 'waiting_for_new_column_name',
};

// Get admin IDs from environment variable (comma-separated)
const ADMIN_IDS = process.env.ADMIN_IDS 
  ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()))
  : [];

function isAdmin(telegramId: number) {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(telegramId);
}

function setupAdminHandlers(bot: Telegraf<Context>, pool: Pool) {
  bot.use(createSessionMiddleware('adminState', 'adminData', ADMIN_STATES.IDLE));

  bot.command(['admin', 'admin_rename'], (ctx) => {
    if (!requireSession(ctx)) return;

    if (!isAdmin(ctx.from.id)) {
      ctx.reply('❌ Access denied. This command is only available for administrators.');
      return;
    }

    ctx.session.adminState = ADMIN_STATES.WAITING_FOR_TABLE;
    ctx.session.adminData = {};
    ctx.reply(
      '🔧 Admin: Rename Column\n\n' +
      'Please enter the table name:'
    );
  });

  bot.command(['admin_add_column', 'add_column'], (ctx) => {
    if (!requireSession(ctx)) return;

    if (!isAdmin(ctx.from.id)) {
      ctx.reply('❌ Access denied. This command is only available for administrators.');
      return;
    }

    ctx.session.adminState = ADMIN_STATES.WAITING_FOR_TABLE_FOR_NEW_COLUMN;
    ctx.session.adminData = {};
    ctx.reply(
      '🔧 Admin: Add New Column\n\n' +
      'Please enter the table name where you want to add a new column:'
    );
  });

  bot.command(['cancel_admin'], (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      ctx.reply('❌ Access denied. This command is only available for administrators.');
      return;
    }

    const result = cancelProcess(ctx, 'adminState', 'adminData', ADMIN_STATES.IDLE, 'admin operation');
    ctx.reply(result.message);
  });

  return async (ctx) => {
    if (!ctx.session || !ctx.session.adminState) {
      return false;
    }

    // Check admin access for all admin operations
    if (!isAdmin(ctx.from.id)) {
      ctx.session.adminState = ADMIN_STATES.IDLE;
      ctx.session.adminData = {};
      return false;
    }
    
    const state = ctx.session.adminState;

    if (!ctx.session.adminData) {
      ctx.session.adminData = {};
    }

    if (state === ADMIN_STATES.WAITING_FOR_TABLE) {
      const tableName = ctx.message.text.trim();
      
      // Basic validation: table name should be alphanumeric with underscores
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
        ctx.reply(
          '❌ Invalid table name. Table names should only contain letters, numbers, and underscores, and start with a letter or underscore.\n\n' +
          'Please enter a valid table name:'
        );
        return true;
      }

      try {
        const tableCheck = await pool.query(
          `SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = $1
          )`,
          [tableName.toLowerCase()]
        );

        if (!tableCheck.rows[0].exists) {
          ctx.reply(
            `❌ Table "${tableName}" does not exist.\n\n` +
            `Please enter a valid table name or use /cancel_admin to cancel:`
          );
          return true;
        }

        ctx.session.adminData.tableName = tableName;
        ctx.session.adminState = ADMIN_STATES.WAITING_FOR_OLD_COLUMN;
        ctx.reply(
          `✅ Table "${tableName}" found.\n\n` +
          `Please enter the current (old) column name to rename:`
        );
      } catch (error) {
        console.error('Database error:', error);
        ctx.reply(
          '❌ Error checking table. Please try again or use /cancel_admin to cancel.'
        );
      }
      return true;
    }

    if (state === ADMIN_STATES.WAITING_FOR_OLD_COLUMN) {
      const oldColumnName = ctx.message.text.trim();
      
      // Basic validation
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(oldColumnName)) {
        ctx.reply(
          '❌ Invalid column name. Column names should only contain letters, numbers, and underscores, and start with a letter or underscore.\n\n' +
          'Please enter a valid column name:'
        );
        return true;
      }

      // Check if column exists in the table
      try {
        const columnCheck = await pool.query(
          `SELECT EXISTS (
            SELECT FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = $1 
            AND column_name = $2
          )`,
          [ctx.session.adminData.tableName.toLowerCase(), oldColumnName.toLowerCase()]
        );

        if (!columnCheck.rows[0].exists) {
          ctx.reply(
            `❌ Column "${oldColumnName}" does not exist in table "${ctx.session.adminData.tableName}".\n\n` +
            `Please enter a valid column name or use /cancel_admin to cancel:`
          );
          return true;
        }

        ctx.session.adminData.oldColumnName = oldColumnName;
        ctx.session.adminState = ADMIN_STATES.WAITING_FOR_NEW_COLUMN;
        ctx.reply(
          `✅ Column "${oldColumnName}" found in table "${ctx.session.adminData.tableName}".\n\n` +
          `Please enter the new column name:`
        );
      } catch (error) {
        console.error('Database error:', error);
        ctx.reply(
          '❌ Error checking column. Please try again or use /cancel_admin to cancel.'
        );
      }
      return true;
    }

    if (state === ADMIN_STATES.WAITING_FOR_NEW_COLUMN) {
      const newColumnName = ctx.message.text.trim();
      
      // Basic validation
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newColumnName)) {
        ctx.reply(
          '❌ Invalid column name. Column names should only contain letters, numbers, and underscores, and start with a letter or underscore.\n\n' +
          'Please enter a valid column name:'
        );
        return true;
      }

      try {
        const newColumnCheck = await pool.query(
          `SELECT EXISTS (
            SELECT FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = $1 
            AND column_name = $2
          )`,
          [ctx.session.adminData.tableName.toLowerCase(), newColumnName.toLowerCase()]
        );

        if (newColumnCheck.rows[0].exists) {
          ctx.reply(
            `❌ Column "${newColumnName}" already exists in table "${ctx.session.adminData.tableName}".\n\n` +
            `Please enter a different column name or use /cancel_admin to cancel:`
          );
          return true;
        }

        const { tableName, oldColumnName } = ctx.session.adminData;
        
        await pool.query(
          `ALTER TABLE "${tableName}" RENAME COLUMN "${oldColumnName}" TO "${newColumnName}"`
        );
        
        ctx.session.adminState = ADMIN_STATES.IDLE;
        ctx.session.adminData = {};
        
        ctx.reply(
          `✅ Column renamed successfully! 🎉\n\n` +
          `Table: ${tableName}\n` +
          `Old name: ${oldColumnName}\n` +
          `New name: ${newColumnName}\n\n` +
          `The column has been renamed in the database.`
        );
      } catch (error) {
        console.error('Database error:', error);
        ctx.reply(
          `❌ Error renaming column: ${error.message}\n\n` +
          `Please check the error and try again or use /cancel_admin to cancel.`
        );
        ctx.session.adminState = ADMIN_STATES.IDLE;
        ctx.session.adminData = {};
      }
      return true;
    }

    if (state === ADMIN_STATES.WAITING_FOR_TABLE_FOR_NEW_COLUMN) {
      const tableName = ctx.message.text.trim();
      
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
        ctx.reply(
          '❌ Invalid table name. Table names should only contain letters, numbers, and underscores, and start with a letter or underscore.\n\n' +
          'Please enter a valid table name:'
        );
        return true;
      }

      try {
        const tableCheck = await pool.query(
          `SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = $1
          )`,
          [tableName.toLowerCase()]
        );

        if (!tableCheck.rows[0].exists) {
          ctx.reply(
            `❌ Table "${tableName}" does not exist.\n\n` +
            `Please enter a valid table name or use /cancel_admin to cancel:`
          );
          return true;
        }

        ctx.session.adminData.tableName = tableName;
        ctx.session.adminState = ADMIN_STATES.WAITING_FOR_NEW_COLUMN_NAME;
        ctx.reply(
          `✅ Table "${tableName}" found.\n\n` +
          `Please enter the name for the new column:`
        );
      } catch (error) {
        console.error('Database error:', error);
        ctx.reply(
          '❌ Error checking table. Please try again or use /cancel_admin to cancel.'
        );
      }
      return true;
    }

    if (state === ADMIN_STATES.WAITING_FOR_NEW_COLUMN_NAME) {
      const newColumnName = ctx.message.text.trim();
      
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newColumnName)) {
        ctx.reply(
          '❌ Invalid column name. Column names should only contain letters, numbers, and underscores, and start with a letter or underscore.\n\n' +
          'Please enter a valid column name:'
        );
        return true;
      }

      try {
        const columnCheck = await pool.query(
          `SELECT EXISTS (
            SELECT FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = $1 
            AND column_name = $2
          )`,
          [ctx.session.adminData.tableName.toLowerCase(), newColumnName.toLowerCase()]
        );

        if (columnCheck.rows[0].exists) {
          ctx.reply(
            `❌ Column "${newColumnName}" already exists in table "${ctx.session.adminData.tableName}".\n\n` +
            `Please enter a different column name or use /cancel_admin to cancel:`
          );
          return true;
        }

        const { tableName } = ctx.session.adminData;
        
        await pool.query(
          `ALTER TABLE "${tableName}" ADD COLUMN "${newColumnName}" TEXT`
        );
        
        ctx.session.adminState = ADMIN_STATES.IDLE;
        ctx.session.adminData = {};
        
        ctx.reply(
          `✅ Column created successfully! 🎉\n\n` +
          `Table: ${tableName}\n` +
          `New column: ${newColumnName}\n` +
          `Type: TEXT\n\n` +
          `The column has been added to the database.`
        );
      } catch (error) {
        console.error('Database error:', error);
        ctx.reply(
          `❌ Error creating column: ${error.message}\n\n` +
          `Please check the error and try again or use /cancel_admin to cancel.`
        );
        ctx.session.adminState = ADMIN_STATES.IDLE;
        ctx.session.adminData = {};
      }
      return true;
    }

    return false;
  };
}

export {
  setupAdminHandlers,
  ADMIN_STATES,
  isAdmin,
};

