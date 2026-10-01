module.exports = {
  ...require('./common'),
  ...require('./catalog'),
  ...require('./vehicles'),
  ...require('./transactions'),
  ...require('./reports'),
  ...require('./work'),
  ...require('./bookings'),
  ...require('./payments'),
  ...require('./marketing'),
  notifications: require('./notifications'),
};
