import { resetDatabase } from '../../scripts/local/db.ts'

export const TEST_DB = 'app_test'

export default async function setup() {
  await resetDatabase(TEST_DB, { seed: false })
}
