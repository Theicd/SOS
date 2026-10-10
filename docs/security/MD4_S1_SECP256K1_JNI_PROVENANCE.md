# MD4 S1 — secp256k1-jni.dll provenance (JVM unit tests)

**Runtime product path:** Android app uses `fr.acinq.secp256k1:secp256k1-kmp-jni-android` (APK native libs).  
**JVM unit tests:** `android-shell/app/build.gradle.kts` sets  
`unitTests.all { jvmArgs("-Djava.library.path=${project.projectDir}/build/native") }`.

## Reproducible placement

1. Dependency: `fr.acinq.secp256k1:secp256k1-kmp-jvm:0.15.0` (+ JNI companion from Maven).  
2. Extract / copy the Windows `secp256k1-jni.dll` into:  
   `android-shell/app/build/native/secp256k1-jni.dll`  
3. Baseline snapshot archives a verified copy at:  
   `C:\BRAIN\SOS-MD3-BASELINE-20261009-155349\native-deps\secp256k1-jni.dll`  
   (SHA-256 recorded in that snapshot `MANIFEST.sha256`).  
4. Before recon Android unit tests: copy snapshot native-deps → `app/build/native/`.

## Notes

- This DLL is a **test harness** dependency for JVM Robolectric/unit tests on Windows, not a desktop browser artifact.  
- Browser MD4 S1 uses **noble/nostr-tools Schnorr** via `verifySchnorrRaw`, not this JNI library.  
- Do not treat presence of the DLL as MD4 cryptographic authority.
