package com.example.smartgoprototype.ui.dashboard

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavHostController
import com.amplifyframework.auth.cognito.result.AWSCognitoAuthSignOutResult
import com.amplifyframework.core.Amplify
import com.example.smartgoprototype.Routes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@Composable
fun DashboardRoute(
    navController: NavHostController,
    onNavigateToAddRoute: () -> Unit,
    viewModel: DashboardViewModel = hiltViewModel()
) {
    val scope = rememberCoroutineScope()
    val uiState by viewModel.uiState.collectAsState()

    DashboardScreen(
        uiState = uiState,
        onAddRouteClick = onNavigateToAddRoute,
        onLogoutClick = {
            Amplify.Auth.signOut { signOutResult ->
                scope.launch(Dispatchers.Main) {
                    when (signOutResult) {
                        is AWSCognitoAuthSignOutResult.CompleteSignOut,
                        is AWSCognitoAuthSignOutResult.PartialSignOut -> {
                            navController.navigate(Routes.LOGIN) {
                                popUpTo(Routes.DASHBOARD) { inclusive = true }
                            }
                        }
                        is AWSCognitoAuthSignOutResult.FailedSignOut -> {
                            Log.e("SmartGoApp", "Sign out failed", signOutResult.exception)
                        }
                    }
                }
            }
        }
    )
}