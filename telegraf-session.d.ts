import { Context } from 'telegraf';

declare module 'telegraf' {
  interface Context {
    session?: {
      registrationState?: string;
      workshopData?: Record<string, any>;
      orderState?: string;
      orderData?: Record<string, any>;
      adminState?: string;
      adminData?: Record<string, any>;
      responseState?: string;
      responseData?: Record<string, any>;
      selectionState?: string;
      selectionData?: Record<string, any>;
    };
  }
}

