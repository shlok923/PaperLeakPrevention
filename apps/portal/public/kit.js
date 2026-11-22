window.__momentsManual = true;
window.kit = Promise.all([
    import("/assets/motion/motion.js"),
    import("/assets/moments/moments.js"),
]).then(([motion, moments]) => ({
    motion: motion.default,
    moments: moments.default,
}));
