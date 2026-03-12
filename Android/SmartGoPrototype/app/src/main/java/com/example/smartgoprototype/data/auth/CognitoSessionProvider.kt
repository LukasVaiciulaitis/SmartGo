package com.example.smartgoprototype.data.auth

import android.util.Log
import com.amplifyframework.auth.cognito.AWSCognitoAuthSession
import com.amplifyframework.core.Amplify
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import kotlin.coroutines.resume

interface SessionProvider {
    /** Suspends to fetch a fresh token from the auth provider, updating the cache. */
    suspend fun getIdToken(): String?

    /** Returns the cached token if within its TTL, or null if cold/expired. Non-blocking. */
    fun getCachedIdToken(): String?

    /** Invalidates the token cache. Call after sign-out. */
    fun clearCache()
}

// Cognito ID tokens last 1 hour; treat as expired 10 minutes early.
private const val TOKEN_TTL_MS = 50L * 60L * 1_000L

class CognitoSessionProvider @Inject constructor() : SessionProvider {

    @Volatile private var cachedToken: String? = null
    @Volatile private var cacheExpiryMs: Long = 0L

    override fun getCachedIdToken(): String? =
        cachedToken?.takeIf { System.currentTimeMillis() < cacheExpiryMs }

    override fun clearCache() {
        cachedToken = null
        cacheExpiryMs = 0L
    }

    override suspend fun getIdToken(): String? {
        getCachedIdToken()?.let { return it }

        return suspendCancellableCoroutine { cont ->
            Amplify.Auth.fetchAuthSession(
                { session ->
                    try {
                        val cognito = session as? AWSCognitoAuthSession
                        if (cognito == null) {
                            Log.e("CognitoSessionProvider", "Not a Cognito session")
                            cont.resume(null)
                            return@fetchAuthSession
                        }

                        Log.d("CognitoSessionProvider", "isSignedIn=${cognito.isSignedIn}")

                        val tokenResult = cognito.userPoolTokensResult
                        val tokens = tokenResult.value
                        val error = tokenResult.error

                        Log.d("CognitoSessionProvider", "tokenResult.value != null: ${tokens != null}")
                        Log.d("CognitoSessionProvider", "tokenResult.error: $error")

                        val idToken = tokens?.idToken

                        Log.d("CognitoSessionProvider", "Got idToken = ${!idToken.isNullOrBlank()}")

                        if (!idToken.isNullOrBlank()) {
                            cachedToken = idToken
                            cacheExpiryMs = System.currentTimeMillis() + TOKEN_TTL_MS
                        }

                        cont.resume(idToken)
                    } catch (e: Exception) {
                        Log.e("CognitoSessionProvider", "Token extraction failed", e)
                        cont.resume(null)
                    }
                },
                { error ->
                    Log.e("CognitoSessionProvider", "fetchAuthSession failed", error)
                    cont.resume(null)
                }
            )
        }
    }
}
