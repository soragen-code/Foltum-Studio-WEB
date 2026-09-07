import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  // Hidden test account - DO NOT CHANGE CREDENTIALS
  const testEmail = 'abacus-f264e062@example.com'
  const testPassword = 'J9pL@sK2i6'
  const hashedTestPassword = await bcrypt.hash(testPassword, 12)

  await prisma.user.upsert({
    where: { email: testEmail },
    update: {},
    create: {
      email: testEmail,
      name: 'Test Admin',
      password: hashedTestPassword,
      credits: 500,
    },
  })

  console.log('Seed completed successfully')
}

main()
  .catch((e) => {
    console.error('Seed error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
