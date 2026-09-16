# @sparkelf/dsh-patch-session-format-legacy-restart

[English](README.md) | 中文

该data-only package在migrate v0 sessions时默认admit released interrupted-turn restart pattern。

official `46196d6f95`在`legacyInterruptedTurnRestart`后面加入该pattern：某个`turn/start`的紧邻前一event是指向`next-turn`的`agent/inbox/spliced`时，该turn已经结束，因此migration关闭open turn并推进`nextTurn`。该flag对该admission做gate；shipped的`RELEASED_V2_RELATIONSHIP_EXTENSIONS`从不设置它，所以除非caller主动开启，否则该pattern被拒绝。

该patch从两方面改变gate。extension从`true`变为`boolean`，condition从`=== true`变为`!== false`。两者合起来使admission成为默认行为，并为需要strict reading的caller提供显式`false`。predecessor lookup也从array index改为按`seq`查找，因为sequence number在remapping后不保证连续。

本deployment有一个session需要它：`session-f6ab795c-0a7b-4287-b3e5-19229e412024`含一个指向`next-turn`的`agent/inbox/spliced` insert，strict gate拒绝它的`turn/start`。本package就是那项deployment change，从mirror stash移入reviewed patch，使rebuild不会丢掉它。

target是exact official source base `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`。Plus apply command在应用前验证base ancestry与payload。本package没有JavaScript entry、Cordis lifecycle、install script或capability implementation。

official session-format migration默认admit interrupted-turn restart pattern，或它服务的session不再存在后，retire本package。
