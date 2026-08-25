import { defineModel } from '@stacksjs/orm'
import { makeHash } from '@stacksjs/security'
import { schema } from '@stacksjs/validation'

/**
 * Account owner. Auth is handled by the `useAuth` trait (password hashing,
 * session + token guards).
 */
export default defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  autoIncrement: true,

  hasMany: ['Subscription'],

  traits: {
    useAuth: {
      usePasskey: false,
    },
    billable: true,
    useTimestamps: true,
    // NO useApi. It generated `GET /api/users`, which returned the entire users
    // table — every name and email address — and answered an UNAUTHENTICATED
    // request locally. Auto-CRUD reads are public unless a model opts in to
    // middleware, and row scoping only engages for a model that declares
    // `ownership` or carries a `team_id`; this one does neither, so nothing
    // narrowed it either.
    //
    // Nothing in this app ever called it. Every route the app actually serves is
    // hand-written in routes/, with the guard on it, so the generated set was
    // pure attack surface. Do not re-add it to expose a user endpoint — write
    // one in routes/ where the guard is visible next to the handler.
  },

  attributes: {
    name: {
      fillable: true,
      validation: {
        rule: schema.string().required().min(2).max(100),
        message: {
          min: 'Name must have at least 2 characters',
          max: 'Name must be at most 100 characters',
        },
      },
      factory: faker => faker.person.fullName(),
    },

    email: {
      unique: true,
      fillable: true,
      validation: {
        rule: schema.string().email().required(),
        message: {
          required: 'Email is required',
          email: 'Email must be a valid email address',
        },
      },
      factory: faker => faker.internet.email(),
    },

    password: {
      hidden: true,
      fillable: true,
      validation: {
        rule: schema.string().required().min(8).max(255),
        message: {
          required: 'Password is required',
          min: 'Password must have at least 8 characters',
        },
      },
      factory: () => 'password123',
    },
  },

  set: {
    password: async (attributes: Record<string, any>) => {
      return await makeHash(attributes.password, { algorithm: 'bcrypt' })
    },
  },
})
