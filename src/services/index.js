module.exports = {
  ...require('./common'),
  ...require('./catalog'),
  ...require('./vehicles'),
  ...require('./transactions'),
  ...require('./reports'),
  ...require('./work'),
  ...require('./bookings'),
  notifications: require('./notifications'),
};
