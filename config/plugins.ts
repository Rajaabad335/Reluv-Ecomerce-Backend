// Does this exist and override JWT_SECRET?
module.exports = {
  'users-permissions': {
    config: {
      jwt: {
        expiresIn: '30d',
        // secret: 'something hardcoded here?' ← this would override .env
      }
    }
  }
}