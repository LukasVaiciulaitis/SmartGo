package com.example.smartgoprototype.data.auth

import android.util.Log
import com.amplifyframework.auth.AuthUserAttributeKey
import com.amplifyframework.auth.cognito.result.AWSCognitoAuthSignOutResult
import com.amplifyframework.auth.options.AuthSignUpOptions
import com.amplifyframework.core.Amplify
import com.example.smartgoprototype.domain.repository.AuthRepository
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import kotlin.coroutines.resume

class CognitoAuthRepository @Inject constructor(
    private val sessionProvider: SessionProvider
) : AuthRepository {

    private fun friendlyMessage(error: Throwable, fallback: String): Exception {
        val message = when (error.javaClass.simpleName) {
            "NotAuthorizedException"         -> "Incorrect email or password."
            "UserNotFoundException"           -> "No account found with that email."
            "UserNotConfirmedException"       -> "Please verify your email before logging in."
            "UsernameExistsException"         -> "An account with this email already exists."
            "CodeMismatchException"           -> "Incorrect code. Please try again."
            "ExpiredCodeException"            -> "That code has expired. Request a new one."
            "LimitExceededException",
            "TooManyFailedAttemptsException"  -> "Too many attempts. Please wait a moment."
            else -> if (error.message?.contains("network", ignoreCase = true) == true ||
                        error.message?.contains("unable to resolve", ignoreCase = true) == true)
                        "Check your connection and try again."
                    else fallback
        }
        return Exception(message)
    }

    override suspend fun login(identifier: String, password: String): Result<Unit> {
        val result = suspendCancellableCoroutine<Result<Unit>> { cont ->
            Amplify.Auth.signIn(
                identifier,
                password,
                { signInResult ->
                    if (signInResult.isSignedIn) {
                        cont.resume(Result.success(Unit))
                    } else {
                        // Cognito may require additional steps (MFA, password reset, etc.).
                        cont.resume(
                            Result.failure(
                                IllegalStateException("Sign-in not complete: ${signInResult.nextStep.signInStep}")
                            )
                        )
                    }
                },
                { error ->
                    Log.e("CognitoAuthRepository", "signIn failed", error)
                    cont.resume(Result.failure(friendlyMessage(error, "Login failed. Please try again.")))
                }
            )
        }
        // Warm the token cache immediately after sign-in so the interceptor's runBlocking
        // fallback is never reached on the first batch of API calls.
        if (result.isSuccess) sessionProvider.getIdToken()
        return result
    }

    override suspend fun register(email: String, password: String): Result<Unit> {
        return suspendCancellableCoroutine { cont ->
            val normalizedEmail = email.trim().lowercase()

            val options = AuthSignUpOptions.builder()
                .userAttribute(AuthUserAttributeKey.email(), normalizedEmail)
                .build()

            Amplify.Auth.signUp(
                normalizedEmail,
                password,
                options,
                { result ->
                    Log.i(
                        "CognitoAuthRepository",
                        "signUp success: isSignUpComplete=${result.isSignUpComplete}, nextStep=${result.nextStep.signUpStep}"
                    )
                    cont.resume(Result.success(Unit))
                },
                { error ->
                    Log.e("CognitoAuthRepository", "signUp failed", error)
                    cont.resume(Result.failure(friendlyMessage(error, "Registration failed. Please try again.")))
                }
            )
        }
    }

    override suspend fun confirmSignUp(email: String, code: String): Result<Unit> {
        return suspendCancellableCoroutine { cont ->
            val normalizedEmail = email.trim().lowercase()

            Amplify.Auth.confirmSignUp(
                normalizedEmail,
                code,
                { result ->
                    if (result.isSignUpComplete) {
                        cont.resume(Result.success(Unit))
                    } else {
                        cont.resume(
                            Result.failure(
                                IllegalStateException(
                                    "Confirmation not complete. Next step: ${result.nextStep}"
                                )
                            )
                        )
                    }
                },
                { error ->
                    Log.e("CognitoAuthRepository", "confirmSignUp failed", error)
                    cont.resume(Result.failure(friendlyMessage(error, "Verification failed. Please try again.")))
                }
            )
        }
    }

    override suspend fun signOut(): Result<Unit> {
        return suspendCancellableCoroutine { cont ->
            Amplify.Auth.signOut { signOutResult ->
                when (signOutResult) {
                    is AWSCognitoAuthSignOutResult.CompleteSignOut,
                    is AWSCognitoAuthSignOutResult.PartialSignOut -> {
                        sessionProvider.clearCache()
                        cont.resume(Result.success(Unit))
                    }
                    is AWSCognitoAuthSignOutResult.FailedSignOut -> {
                        Log.e("CognitoAuthRepository", "signOut failed", signOutResult.exception)
                        cont.resume(Result.failure(signOutResult.exception))
                    }
                }
            }
        }
    }
}
