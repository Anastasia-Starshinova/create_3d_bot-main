import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { Pool } from 'pg';
import LocalSession from 'telegraf-session-local';
import { setupRegistrationHandlers } from './handlers/registration';
import { setupOrderHandlers, ORDER_STATES } from './handlers/order';
import { setupAdminHandlers } from './handlers/admin';
import { setupResponseHandlers } from './handlers/responses';
import { setupSelectionHandlers } from './handlers/selection';

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING;

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.error('Please set BOT_TOKEN in your .env file');
  process.exit(1);
}

if (!DB_CONNECTION_STRING) {
  console.error('Please set DB_CONNECTION_STRING in your .env file');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_CONNECTION_STRING,
});

const bot = new Telegraf(BOT_TOKEN);

const localSession = new LocalSession({ database: 'sessions.json' });
bot.use(localSession.middleware());

// Set bot commands menu
bot.telegram.setMyCommands([
  { command: 'order', description: 'Create a new 3D print order' },
  { command: 'register', description: 'Register a new workshop' },
  { command: 'reset', description: 'Reset the bot session' }
]);

bot.command(['start', 'help'], (ctx) => {
  if (ctx.session) {
    ctx.session.registrationState = 'idle';
    ctx.session.workshopData = {};
    ctx.session.orderState = 'idle';
    ctx.session.orderData = {};
    ctx.session.adminState = 'idle';
    ctx.session.adminData = {};
    ctx.session.responseState = 'idle';
    ctx.session.responseData = {};
    ctx.session.selectionState = 'idle';
    ctx.session.selectionData = {};
  }
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Order', 'start_order')]
  ]);
  const text = `Welcome! 👋\n\nI can help you:\n
  • View all workshops - just send any message\n
  • Register a new workshop - use /register\n
  • Create a print order - use /order\n
  • Cancel registration - use /cancel_registration\n
  • Cancel order - use /cancel_order\n
  • Reset session - use /reset`;
  ctx.reply(text, keyboard);
});

bot.command('reset', (ctx) => {
  if (ctx.session) {
    ctx.session.registrationState = 'idle';
    ctx.session.workshopData = {};
    ctx.session.orderState = 'idle';
    ctx.session.orderData = {};
    ctx.session.adminState = 'idle';
    ctx.session.adminData = {};
    ctx.session.responseState = 'idle';
    ctx.session.responseData = {};
    ctx.session.selectionState = 'idle';
    ctx.session.selectionData = {};
  }
  ctx.reply('✅ Session reset! You can start fresh now.\n\nUse /register to add a new workshop, /order to create a print order, or just send a message to see all workshops.');
});

const handleRegistration = setupRegistrationHandlers(bot, pool);
const handleOrder = setupOrderHandlers(bot, pool);
const handleAdmin = setupAdminHandlers(bot, pool);
const handleResponse = setupResponseHandlers(bot, pool);
const handleSelection = setupSelectionHandlers(bot, pool);

bot.action('start_order', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) {
    ctx.reply('Session error. Please try /reset and try again.');
    return;
  }
  // Trigger the order process directly
  ctx.session.orderState = ORDER_STATES.WAITING_FOR_DESCRIPTION;
  ctx.session.orderData = {};
  ctx.reply('Let\'s create a new 3D print order! 🖨️\n\nPlease provide a description of your order. Include details such as:\n• Sizes (dimensions)\n• Material (PLA, ABS, PETG, etc.)\n• Color preferences\n• Any other specifications\n\nType your description:');
});

bot.on('text', async (ctx) => {
  // Check admin handler first (most specific)
  const handledByAdmin = await handleAdmin(ctx);
  if (handledByAdmin) {
    return;
  }
  
  const handledByResponse = await handleResponse(ctx);
  if (handledByResponse) {
    return;
  }
  
  const handledByOrder = await handleOrder(ctx);
  if (handledByOrder) {
    return;
  }
  
  const handledByRegistration = await handleRegistration(ctx);
  if (handledByRegistration) {
    return;
  }
  
  const handledBySelection = await handleSelection(ctx);
  if (handledBySelection) {
    return;
  }
  
  ctx.reply('Please type /start to work with the bot.');
});

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
});

bot.launch()
  .then(() => {
    console.log('Bot is running...');
  })
  .catch((err) => {
    console.error('Error starting bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

