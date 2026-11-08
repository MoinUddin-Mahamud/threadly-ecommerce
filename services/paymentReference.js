'use strict';

// A manual-payment reference is text the customer types.

// Sets the flag on every order that carries `ref` when more than one does, and clears it when only
// one (or none) is left.
async function refreshReferenceFlag(Order, ref) {
  if (typeof ref !== 'string' || !ref) return;
  const count = await Order.countDocuments({ paymentReference: ref });
  if (count > 1) {
    await Order.updateMany({ paymentReference: ref }, { $set: { paymentReferenceDuplicate: true } });
  } else {
    await Order.updateMany({ paymentReference: ref, paymentReferenceDuplicate: true }, { $unset: { paymentReferenceDuplicate: 1 } });
  }
}

// A reference must not be unique: a stranger could claim a real transfer reference first and block
// its owner. If the database still has a UNIQUE index on paymentReference, drop it (once) and build
// the plain one the model declares.
async function fixPaymentReferenceIndex(Order, log = console) {
  try {
    let indexes = [];
    try {
      indexes = await Order.collection.indexes();
    } catch (err) {
      if (!(err && (err.code === 26 || /ns does not exist|NamespaceNotFound/i.test(String(err.message))))) throw err;   // no collection yet: nothing to drop
    }
    const legacy = indexes.find((ix) => ix.unique && ix.key && Object.keys(ix.key).length === 1 && ix.key.paymentReference === 1);
    if (legacy) {
      await Order.collection.dropIndex(legacy.name);
      log.log('Dropped the old unique index on paymentReference.');
    }
    await Order.createIndexes();
    return !!legacy;
  } catch (err) {
    log.error('Could not update the paymentReference index:', err && err.message);
    return false;
  }
}

module.exports = { refreshReferenceFlag, fixPaymentReferenceIndex };
