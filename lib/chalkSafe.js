function makeCallableProxy() {
    const passthrough = (value) => value;
    return new Proxy(passthrough, {
        get() {
            return makeCallableProxy();
        },
        apply(_target, _thisArg, args) {
            return args[0];
        }
    });
}

let chalk;

try {
    chalk = require('chalk');
} catch {
    chalk = makeCallableProxy();
}

module.exports = chalk;
