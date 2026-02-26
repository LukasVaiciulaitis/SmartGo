package com.example.smartgoprototype.data.auth

import android.util.Log
import com.amplifyframework.auth.cognito.AWSCognitoAuthSession
import com.amplifyframework.core.Amplify
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import kotlin.coroutines.resume

/**
 * Small abstraction over where to get auth tokens
 *
 * This keeps networking code (OkHttp/Retrofit) from depending directly on the Amplify/Cognito APIs,
 * which makes the interceptor and repositories easier to test and easier to swap in the future.
 */
interface SessionProvider {
    /**
     * @return A JWT ID token to send to the backend, or null if the user is signed out / unavailable.
     */
    suspend fun getIdToken(): String?
}

/**
 * Amplify/Cognito implementation of [SessionProvider].
 *
 * This converts Amplify's callback-based API into a suspend function using
 * `suspendCancellableCoroutine`, so callers can use normal coroutine patterns.
 */
class CognitoSessionProvider @Inject constructor() : SessionProvider {

    override suspend fun getIdToken(): String? {
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

                        // Logging for testing
                        Log.d("CognitoSessionProvider", "tokenResult.value != null: ${tokens != null}")
                        Log.d("CognitoSessionProvider", "tokenResult.error: $error")

                        val idToken = tokens?.idToken

                        Log.d("CognitoSessionProvider", "Got idToken = ${!idToken.isNullOrBlank()}")

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
