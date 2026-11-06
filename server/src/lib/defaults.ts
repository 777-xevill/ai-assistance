import type {
  AISettings,
  BookingSettings,
  BusinessProfile,
  BusinessType,
  CommerceSettings,
  OrderField,
  ReportSettings,
  WeeklyHours,
} from '../types.ts';

export const BUSINESS_TYPES: { id: BusinessType; label: string }[] = [
  { id: 'ecommerce', label: 'Online store / e-commerce' },
  { id: 'services', label: 'Salon, spa, clinic or local service' },
  { id: 'agency', label: 'Agency or B2B services' },
  { id: 'restaurant', label: 'Restaurant, cafe or food business' },
  { id: 'real_estate', label: 'Real estate' },
  { id: 'education', label: 'Education or coaching' },
  { id: 'healthcare', label: 'Healthcare' },
  { id: 'other', label: 'Other' },
];

export function defaultHours(): WeeklyHours {
  const day = [{ open: '09:00', close: '18:00' }];
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: [] };
}

const GOALS: Record<BusinessType, string> = {
  ecommerce:
    'Help shoppers find the right products, answer questions about price, size, stock and delivery, and turn interested shoppers into confirmed orders by collecting their delivery details.',
  services:
    'Answer questions about services and prices, recommend the right service, and book appointments at times that are actually available.',
  agency:
    'Understand what the prospect needs, qualify them (needs, budget, timeline, decision maker), answer questions about services and typical pricing, and book a discovery call with qualified leads.',
  restaurant:
    'Answer menu questions, take food orders for delivery or pickup with complete details, and help with table reservations.',
  real_estate:
    'Answer questions about listings, qualify buyers and renters (budget, location, size, timeline, financing), and book property viewings.',
  education:
    'Explain courses, fees and schedules, understand each prospective student’s goals, and book a consultation or enrolment call.',
  healthcare:
    'Answer general questions about services, prices and timings, and book appointments. Never give diagnoses or medical advice; refer clinical questions to the team.',
  other:
    'Answer customer questions accurately, capture their contact details and needs, and move them toward a purchase or booking.',
};

const LEAD_QUESTIONS: Partial<Record<BusinessType, string[]>> = {
  agency: [
    'What service do you need help with?',
    'What budget range do you have in mind?',
    'When would you like to start?',
    'What is your company name or website?',
  ],
  real_estate: [
    'Are you looking to buy or rent?',
    'Which area or location do you prefer?',
    'What is your budget range?',
    'How many bedrooms / what size do you need?',
    'When are you planning to move?',
  ],
  education: ['Which course or subject are you interested in?', 'What is your current level?', 'Which schedule suits you?'],
};

export function defaultOrderFields(type: BusinessType): OrderField[] {
  const fields: OrderField[] = [
    { key: 'name', label: 'Full name', required: true },
    { key: 'phone', label: 'Phone number', required: true },
    { key: 'address', label: 'Full delivery address', required: true },
  ];
  if (type === 'restaurant') fields.push({ key: 'delivery_or_pickup', label: 'Delivery or pickup', required: true });
  return fields;
}

export function defaultSettings(type: BusinessType): {
  profile: BusinessProfile;
  ai: AISettings;
  commerce: CommerceSettings;
  booking: BookingSettings;
  reporting: ReportSettings;
} {
  const bookingTypes: BusinessType[] = ['services', 'healthcare', 'agency', 'real_estate', 'education'];
  return {
    profile: {
      description: '',
      hours: defaultHours(),
      policies: {},
    },
    ai: {
      enabled: true,
      assistantName: 'Maya',
      tone: 'friendly',
      language: 'auto',
      emoji: 'light',
      replyDelaySeconds: 2,
      goal: GOALS[type],
      customInstructions: '',
      handoffRules: '',
      leadQuestions: LEAD_QUESTIONS[type] ?? [],
      followUp: { enabled: true, firstAfterMinutes: 180, secondAfterMinutes: 1200 },
      pauseAfterHumanMinutes: 60,
      pauseAfterHandoffMinutes: 180,
    },
    commerce: {
      ordersEnabled: type === 'ecommerce' || type === 'restaurant',
      orderFields: defaultOrderFields(type),
      deliveryZones: [],
      paymentMethods: [{ id: 'cod', name: 'Cash on delivery' }],
      freeDeliveryMinimum: null,
      afterOrderMessage: '',
    },
    booking: {
      enabled: bookingTypes.includes(type),
      slotMinutes: 30,
      defaultDurationMinutes: type === 'agency' ? 30 : 60,
      capacityPerSlot: 1,
      minNoticeMinutes: 120,
      maxDaysAhead: 30,
      hours: null,
      afterBookingMessage: '',
    },
    reporting: {
      dailyEnabled: true,
      dailyHour: 21,
      weeklyEnabled: true,
      extraRecipients: [],
      alerts: { newOrder: true, newBooking: true, hotLead: true, handoff: true },
    },
  };
}

export function goalForType(type: BusinessType): string {
  return GOALS[type];
}

export function leadQuestionsForType(type: BusinessType): string[] {
  return LEAD_QUESTIONS[type] ?? [];
}
