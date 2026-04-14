package com.example.smartgoprototype.ui.register

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.data.auth.PendingRegistrationCredentials
import com.example.smartgoprototype.domain.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the "Confirm sign-up" step (verification code entry).
 *
 * After a successful confirmation it automatically signs the user in using the credentials
 * stored by [RegisterViewModel] in [PendingRegistrationCredentials], so the Dashboard
 * has a valid token from the moment it loads.
 */
@HiltViewModel
class ConfirmSignUpViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val pendingCredentials: PendingRegistrationCredentials
) : ViewModel() {

    var uiState by mutableStateOf(ConfirmSignUpUiState())
        private set

    /**
     * Username is passed through navigation; this helper ensures it survives recomposition.
     */
    fun initUsername(username: String) {
        if (uiState.username.isBlank()) {
            uiState = uiState.copy(username = username.trim().lowercase())
        }
    }

    fun onCodeChanged(newCode: String) {
        uiState = uiState.copy(
            code = newCode,
            errorMessage = null
        )
    }

    fun onConfirmClicked() {
        val code = uiState.code.trim()
        val username = uiState.username

        //validate early for better UX.
        if (code.length != 6) {
            uiState = uiState.copy(errorMessage = "Enter the 6-digit code")
            return
        }

        uiState = uiState.copy(isLoading = true, errorMessage = null)

        viewModelScope.launch {
            val confirmResult = authRepository.confirmSignUp(username, code)

            if (confirmResult.isFailure) {
                uiState = uiState.copy(
                    isLoading = false,
                    errorMessage = confirmResult.exceptionOrNull()?.message
                        ?: "Verification failed. Please try again."
                )
                return@launch
            }

            // Email verified — now sign the user in so the Dashboard has a valid token.
            val email = pendingCredentials.email
            val password = pendingCredentials.password
            pendingCredentials.clear()

            val loginResult = authRepository.login(email, password)
            uiState = loginResult.fold(
                onSuccess = {
                    uiState.copy(isLoading = false, isSuccess = true, errorMessage = null)
                },
                onFailure = {
                    // Confirmation succeeded but auto-login failed — send the user to
                    // the login screen rather than leaving them stuck.
                    uiState.copy(isLoading = false, shouldFallBackToLogin = true)
                }
            )
        }
    }
}