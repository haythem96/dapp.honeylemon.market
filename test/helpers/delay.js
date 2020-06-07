module.exports = async ms =>
  new Promise(resolve =>
    setTimeout(() => {
      resolve();
    }, ms)
  );
