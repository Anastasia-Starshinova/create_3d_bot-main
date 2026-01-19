import { Telegraf, Context } from 'telegraf';
import { Pool } from 'pg';
import { createSessionMiddleware, cancelProcess, requireSession } from '../utils/session';

const REGISTRATION_STATES = {
  IDLE: 'idle',
  WAITING_FOR_NAME: 'waiting_for_name',
  WAITING_FOR_CITY: 'waiting_for_city',
  WAITING_FOR_CONTACT: 'waiting_for_contact',
};

function setupRegistrationHandlers(bot: Telegraf<Context>, pool: Pool) {
  bot.use(createSessionMiddleware('registrationState', 'workshopData', REGISTRATION_STATES.IDLE));

  bot.command(['register', 'new'], (ctx) => {
    if (!requireSession(ctx)) return;
    ctx.session.registrationState = REGISTRATION_STATES.WAITING_FOR_NAME;
    ctx.session.workshopData = {};
    ctx.reply('Let\'s register a new workshop!\n\nPlease enter the workshop name:');
  });

  bot.command(['cancel_registration'], (ctx) => {
    const result = cancelProcess(ctx, 'registrationState', 'workshopData', REGISTRATION_STATES.IDLE, 'registration');
    ctx.reply(result.message);
  });

  return async (ctx) => {
    if (!ctx.session || !ctx.session.registrationState) {
      return false;
    }
    
    const state = ctx.session.registrationState;

    if (!ctx.session.workshopData) {
      ctx.session.workshopData = {};
    }

    if (state === REGISTRATION_STATES.WAITING_FOR_NAME) {
      ctx.session.workshopData.name = ctx.message.text;
      ctx.session.registrationState = REGISTRATION_STATES.WAITING_FOR_CITY;
      ctx.reply('Great! Now please enter the city:');
      return true;
    }

    if (state === REGISTRATION_STATES.WAITING_FOR_CITY) {
      ctx.session.workshopData.city = ctx.message.text;
      ctx.session.registrationState = REGISTRATION_STATES.WAITING_FOR_CONTACT;
      ctx.reply('Good! Now please enter the contact information:');
      return true;
    }

    if (state === REGISTRATION_STATES.WAITING_FOR_CONTACT) {
      ctx.session.workshopData.contact = ctx.message.text;
      
      try {
        const telegramId = ctx.from.id;
        const { name, city, contact } = ctx.session.workshopData;
        const createdAt = new Date();
        
        await pool.query(
          'INSERT INTO workshops (telegram_id, name, city, contact, created_at) VALUES ($1, $2, $3, $4, $5)',
          [telegramId, name, city, contact, createdAt]
        );
        
        ctx.session.registrationState = REGISTRATION_STATES.IDLE;
        ctx.session.workshopData = {};
        
        ctx.reply(`✅ Workshop registered successfully!\n\nName: ${name}\nCity: ${city}\nContact: ${contact}\nRegistered: ${createdAt.toLocaleString()}`);
      } catch (error) {
        console.error('Database error:', error);
        ctx.reply('Sorry, there was an error saving the workshop. Please try again with /register');
        ctx.session.registrationState = REGISTRATION_STATES.IDLE;
        ctx.session.workshopData = {};
      }
      return true;
    }

    return false;
  };
}

export {
  setupRegistrationHandlers,
  REGISTRATION_STATES,
};

