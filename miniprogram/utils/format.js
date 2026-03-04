function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatTime(ts) {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

module.exports = {
  formatTime
};
