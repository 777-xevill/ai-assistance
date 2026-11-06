// Creates a demo account with two example businesses so you can try the dashboard and test chat.
//   npm run seed
// Stop the dev server first when using the embedded database (PGlite allows one process at a time).

import { eq } from 'drizzle-orm';
import { closeDb, db, initDb } from '../db/index.ts';
import { catalogItems, knowledgeEntries, users, workspaces } from '../db/schema.ts';
import { hashPassword } from '../lib/crypto.ts';
import { defaultHours } from '../lib/defaults.ts';
import { createWorkspace } from '../services/workspace.ts';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@example.com';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo12345';

async function seedFashion(ownerId: string) {
  const ws = await createWorkspace({ name: 'Nova Fashion', businessType: 'ecommerce', ownerId, timezone: 'Asia/Dhaka', currency: 'BDT' });
  await db
    .update(workspaces)
    .set({
      onboardedAt: new Date(),
      profile: {
        description:
          'Nova Fashion sells trendy, affordable clothing for women and men across Bangladesh: kurtis, three-pieces, panjabis, t-shirts and accessories. Cash on delivery everywhere.',
        phone: '+880 1700-000000',
        email: 'hello@novafashion.example',
        address: 'House 12, Road 5, Dhanmondi, Dhaka',
        hours: { ...defaultHours(), fri: [] },
        policies: {
          shipping: 'Inside Dhaka 1-2 days, outside Dhaka 3-5 days. Customers can check the product before paying the delivery person.',
          returns: '7-day exchange for size or defects if the tag is intact. Delivery charge is not refunded.',
          payment: 'Cash on delivery, bKash or Nagad. For orders above ৳5,000 we ask for a ৳200 advance.',
        },
        extraInfo: 'Sizes run regular. Kurti sizes: M (36), L (38), XL (40), XXL (42) chest.',
      },
      commerce: {
        ordersEnabled: true,
        orderFields: [
          { key: 'name', label: 'Full name', required: true },
          { key: 'phone', label: 'Phone number', required: true },
          { key: 'address', label: 'Full delivery address', required: true },
        ],
        deliveryZones: [
          { id: 'inside-dhaka', name: 'Inside Dhaka', fee: 70, eta: '1-2 days' },
          { id: 'dhaka-suburbs', name: 'Dhaka suburbs (Savar, Gazipur, Narayanganj)', fee: 100, eta: '2-3 days' },
          { id: 'outside-dhaka', name: 'Outside Dhaka', fee: 130, eta: '3-5 days' },
        ],
        paymentMethods: [
          { id: 'cod', name: 'Cash on delivery' },
          { id: 'bkash', name: 'bKash', instructions: 'Send money to 01700-000000 (personal) and share the transaction ID.' },
          { id: 'nagad', name: 'Nagad', instructions: 'Send money to 01700-000000 and share the transaction ID.' },
        ],
        freeDeliveryMinimum: 3000,
        afterOrderMessage: 'Our team will call you within a few hours to confirm the order.',
      },
    })
    .where(eq(workspaces.id, ws.id));

  await db.insert(catalogItems).values([
    {
      workspaceId: ws.id,
      name: 'Floral Cotton Kurti',
      description: 'Soft breathable cotton kurti with a floral block print. Perfect for daily and office wear.',
      category: 'Kurti',
      price: 1450,
      salePrice: 1250,
      stock: 24,
      variants: [
        { name: 'Size', options: ['M', 'L', 'XL', 'XXL'] },
        { name: 'Color', options: ['Blue', 'Maroon', 'Mint'] },
      ],
      tags: ['cotton', 'summer', 'casual'],
      attributes: { Fabric: '100% cotton', Length: '42 inches' },
    },
    {
      workspaceId: ws.id,
      name: 'Georgette Three-Piece',
      description: 'Embroidered georgette three-piece with dupatta and inner. Party and Eid wear.',
      category: 'Three-piece',
      price: 3200,
      stock: 9,
      variants: [{ name: 'Color', options: ['Black', 'Royal blue', 'Peach'] }],
      tags: ['party', 'eid', 'embroidered'],
      attributes: { Fabric: 'Georgette', Type: 'Unstitched' },
    },
    {
      workspaceId: ws.id,
      name: "Men's Classic Panjabi",
      description: 'Slim-fit cotton-blend panjabi with subtle self-pattern. Comfortable for Jummah and events.',
      category: 'Panjabi',
      price: 2100,
      stock: 15,
      variants: [
        { name: 'Size', options: ['38', '40', '42', '44'] },
        { name: 'Color', options: ['White', 'Off-white', 'Navy'] },
      ],
      tags: ['men', 'eid', 'cotton'],
    },
    {
      workspaceId: ws.id,
      name: 'Oversized Graphic T-shirt',
      description: 'Unisex drop-shoulder tee, 200 GSM combed cotton.',
      category: 'T-shirt',
      price: 650,
      stock: 0,
      variants: [{ name: 'Size', options: ['M', 'L', 'XL'] }],
      tags: ['unisex', 'streetwear'],
    },
  ]);

  await db.insert(knowledgeEntries).values([
    { workspaceId: ws.id, question: 'Do you have a physical shop?', answer: 'Yes, our showroom is in Dhanmondi (House 12, Road 5), open Saturday to Thursday, 10am to 8pm.' },
    { workspaceId: ws.id, question: 'Can I check the product before paying?', answer: 'Yes. You can check the product in front of the delivery person before paying.' },
    { workspaceId: ws.id, question: 'Do you do wholesale?', answer: 'Yes, for 20+ pieces. Our team will share wholesale prices directly.' },
  ]);
  return ws;
}

async function seedSalon(ownerId: string) {
  const ws = await createWorkspace({ name: 'Glow Salon & Spa', businessType: 'services', ownerId, timezone: 'Asia/Dhaka', currency: 'BDT' });
  const hours = defaultHours();
  await db
    .update(workspaces)
    .set({
      onboardedAt: new Date(),
      profile: {
        description: 'Glow is a ladies-only salon and spa in Gulshan offering hair, skin, nail and bridal services by trained stylists.',
        phone: '+880 1800-000000',
        address: 'Road 90, Gulshan 2, Dhaka',
        hours: { ...hours, sat: [{ open: '10:00', close: '20:00' }], sun: [{ open: '10:00', close: '20:00' }], fri: [{ open: '15:00', close: '20:00' }] },
        policies: { other: 'Please arrive 10 minutes early. Cancel at least 3 hours before your appointment. Bridal bookings need a ৳2,000 advance.' },
      },
      booking: {
        enabled: true,
        slotMinutes: 30,
        defaultDurationMinutes: 60,
        capacityPerSlot: 2,
        minNoticeMinutes: 120,
        maxDaysAhead: 30,
        hours: null,
        afterBookingMessage: 'We will send a reminder the day before. See you soon!',
      },
    })
    .where(eq(workspaces.id, ws.id));

  await db.insert(catalogItems).values([
    { workspaceId: ws.id, type: 'service', name: 'Haircut & Blow-dry', description: 'Consultation, wash, cut and blow-dry.', category: 'Hair', price: 1200, durationMinutes: 60 },
    { workspaceId: ws.id, type: 'service', name: 'Hair Color (global)', description: 'Full-head color with ammonia-free products. Price varies with hair length.', category: 'Hair', price: 3500, durationMinutes: 120 },
    { workspaceId: ws.id, type: 'service', name: 'Hydrating Facial', description: 'Deep cleanse, exfoliation, mask and massage for glowing skin.', category: 'Skin', price: 2500, durationMinutes: 75 },
    { workspaceId: ws.id, type: 'service', name: 'Gel Manicure', description: 'Nail shaping, cuticle care and long-lasting gel polish.', category: 'Nails', price: 1500, durationMinutes: 45 },
    { workspaceId: ws.id, type: 'service', name: 'Bridal Makeup Package', description: 'HD bridal makeup, hairstyle, draping and trial session.', category: 'Bridal', price: 25000, durationMinutes: 240 },
  ]);
  await db.insert(knowledgeEntries).values([
    { workspaceId: ws.id, question: 'Do you serve men?', answer: 'No, Glow is a ladies-only salon.' },
    { workspaceId: ws.id, question: 'Is parking available?', answer: 'Yes, there is free parking in front of the building.' },
  ]);
  return ws;
}

async function main() {
  await initDb();
  const [existing] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  if (existing) {
    console.log(`Demo account already exists: ${EMAIL}. Nothing to do.`);
    return;
  }
  const [user] = await db.insert(users).values({ email: EMAIL, name: 'Demo Owner', passwordHash: await hashPassword(PASSWORD) }).returning();
  const fashion = await seedFashion(user.id);
  const salon = await seedSalon(user.id);
  console.log(`Demo account created.
  Sign in:  ${EMAIL} / ${PASSWORD}
  Businesses: ${fashion.name}, ${salon.name}
Open the dashboard, then try "Test chat" to talk to each assistant.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
